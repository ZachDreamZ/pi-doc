/**
 * pi-doc — API documentation generator for pi.dev extensions.
 *
 * Three tools:
 *   doc_generate  — Parse TypeBox schemas from extension source and generate Markdown/HTML docs
 *   doc_serve     — Serve generated docs locally via a simple HTTP server
 *   doc_validate  — Check documentation coverage against registered tools
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

// ─── TypeBox Schemas ──────────────────────────────────────────────────────────

const DocGenerateParams = Type.Object({
  source: Type.String({
    description: "Path to the extension directory containing TypeScript source files",
  }),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
      description: "Output format: 'markdown' or 'html' (default: 'markdown')",
    }),
  ),
  output: Type.Optional(
    Type.String({
      description: "Output directory for generated docs (default: './docs')",
    }),
  ),
});

const DocServeParams = Type.Object({
  docs: Type.Optional(
    Type.String({
      description: "Path to the docs directory to serve (default: './docs')",
    }),
  ),
  port: Type.Optional(
    Type.Number({
      description: "Port to serve on (default: 8080)",
      minimum: 1,
      maximum: 65535,
    }),
  ),
});

const DocValidateParams = Type.Object({
  source: Type.String({
    description: "Path to the extension directory to validate",
  }),
  minCoverage: Type.Optional(
    Type.Number({
      description: "Minimum coverage ratio required (0-1, default: 0.8)",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

// ─── Schema Parsing ───────────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, PropertyInfo>;
  required: string[];
}

export interface PropertyInfo {
  type: string;
  description: string;
  required: boolean;
  default?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ParsedExtension {
  name: string;
  description: string;
  tools: ToolInfo[];
}

/**
 * Parse TypeScript source files to extract tool registrations and TypeBox schemas.
 */
export function parseExtensionSources(sourceDir: string): ParsedExtension {
  const tsFiles = findTsFiles(sourceDir);
  const tools: ToolInfo[] = [];
  let extensionName = path.basename(sourceDir);
  let extensionDescription = "";

  for (const filePath of tsFiles) {
    const content = fs.readFileSync(filePath, "utf-8");

    // Extract extension description from JSDoc at top
    const descMatch = content.match(/\/\*\*\s*\n\s*\*\s*(.+?)(?:\s*\n[\s\S]*?)?\s*\*\//);
    if (descMatch && !extensionDescription) {
      extensionDescription = descMatch[1].trim();
    }

    // Find registerTool calls with their block context
    const toolBlocks = extractToolBlocks(content);
    for (const block of toolBlocks) {
      const tool = parseToolBlock(block);
      if (tool) {
        tools.push(tool);
      }
    }
  }

  return { name: extensionName, description: extensionDescription, tools };
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      results.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract registerTool(...) call blocks from source code.
 * Returns the full call text from `registerTool({` to the closing `})`.
 */
function extractToolBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /registerTool\s*\(\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const start = match.index;
    let braceDepth = 0;
    let i = content.indexOf("{", match.index + match[0].length - 1);
    let end = -1;

    for (; i < content.length; i++) {
      if (content[i] === "{") braceDepth++;
      else if (content[i] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end > start) {
      blocks.push(content.slice(start, end));
    }
  }

  return blocks;
}

/**
 * Parse a single registerTool block to extract tool info.
 */
function parseToolBlock(block: string): ToolInfo | null {
  // Extract name
  const nameMatch = block.match(/name\s*:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;

  // Extract description
  const descMatch = block.match(/description\s*:\s*["'`]([^"'`]+)["'`]/);

  // Extract parameters from Type.Object({ ... })
  const paramsMatch = block.match(/parameters\s*:\s*Type\.Object\s*\(\s*\{/);
  const parameters: Record<string, PropertyInfo> = {};
  const required: string[] = [];

  if (paramsMatch) {
    const paramsStart = block.indexOf("{", block.indexOf("Type.Object", block.indexOf("parameters")));
    if (paramsStart > -1) {
      const paramBlock = extractBalancedBlock(block, paramsStart);
      if (paramBlock) {
        parseProperties(paramBlock, parameters, required);
      }
    }
  }

  return {
    name: nameMatch[1],
    description: descMatch?.[1] ?? "",
    parameters,
    required,
  };
}

function extractBalancedBlock(content: string, startIdx: number): string | null {
  let depth = 0;
  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * Parse TypeBox property definitions from a Type.Object body.
 */
function parseProperties(
  block: string,
  params: Record<string, PropertyInfo>,
  required: string[],
): void {
  // Match property declarations: propName: [Type.Optional(] Type.TypeName({ ... }) [)]
  const propDeclRegex =
    /(\w+)\s*:\s*(?:Type\.Optional\s*\(\s*)?(?:Type\.)?(String|Number|Boolean|Array|Union|Literal|Enum)\s*\(\s*\{([^}]*)\}\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = propDeclRegex.exec(block)) !== null) {
    const propName = match[1];
    const propType = match[2].toLowerCase();
    const optsBlock = match[3];
    const fullMatch = match[0];

    const isOptional = fullMatch.includes("Optional");

    const descMatch = optsBlock.match(/description\s*:\s*["'`]([^"'`]+)["'`]/);
    const minMatch = optsBlock.match(/minimum\s*:\s*(\d+)/);
    const maxMatch = optsBlock.match(/maximum\s*:\s*(\d+)/);

    const prop: PropertyInfo = {
      type: propType,
      description: descMatch?.[1] ?? "",
      required: !isOptional,
    };
    if (minMatch) prop.minimum = Number(minMatch[1]);
    if (maxMatch) prop.maximum = Number(maxMatch[1]);

    params[propName] = prop;
    if (!isOptional) required.push(propName);
  }
}

// ─── Documentation Generation ─────────────────────────────────────────────────

/**
 * Generate Markdown documentation from parsed extension info.
 */
export function generateMarkdown(ext: ParsedExtension): string {
  const lines: string[] = [];

  lines.push(`# ${ext.name}`);
  lines.push("");
  if (ext.description) {
    lines.push(`> ${ext.description}`);
    lines.push("");
  }
  lines.push(`## API Documentation`);
  lines.push("");
  lines.push(`This extension registers **${ext.tools.length} tool${ext.tools.length !== 1 ? "s" : ""}**.`);
  lines.push("");

  for (const tool of ext.tools) {
    lines.push(`### \`${tool.name}\``);
    lines.push("");
    if (tool.description) {
      lines.push(tool.description);
      lines.push("");
    }

    const paramEntries = Object.entries(tool.parameters);
    if (paramEntries.length > 0) {
      lines.push("**Parameters:**");
      lines.push("");
      for (const [name, prop] of paramEntries) {
        const req = prop.required ? "required" : "optional";
        let typeStr = prop.type;
        if (prop.enum && prop.enum.length > 0) {
          typeStr = `enum(${prop.enum.join("|")})`;
        }
        let line = `- \`${name}\` (${typeStr}, ${req})`;
        if (prop.description) line += ` — ${prop.description}`;
        if (prop.minimum !== undefined) line += ` (min: ${prop.minimum})`;
        if (prop.maximum !== undefined) line += ` (max: ${prop.maximum})`;
        if (prop.default !== undefined) line += ` (default: ${prop.default})`;
        lines.push(line);
      }
      lines.push("");
    } else {
      lines.push("*No parameters.*");
      lines.push("");
    }

    if (tool.required.length > 0) {
      lines.push(`**Required:** ${tool.required.map((r) => `\`${r}\``).join(", ")}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate HTML documentation from parsed extension info.
 */
export function generateHTML(ext: ParsedExtension): string {
  const toolRows = ext.tools
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([name, prop]) => {
          const req = prop.required ? "required" : "optional";
          const typeStr = prop.enum?.length
            ? `enum(${prop.enum.join("|")})`
            : prop.type;
          return `<tr>
            <td><code>${name}</code></td>
            <td>${typeStr}</td>
            <td>${req}</td>
            <td>${prop.description || "—"}</td>
          </tr>`;
        })
        .join("\n");

      return `
      <div class="tool">
        <h3><code>${tool.name}</code></h3>
        <p>${tool.description || "No description."}</p>
        ${
          params
            ? `<table>
          <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>${params}</tbody>
        </table>`
            : "<p><em>No parameters.</em></p>"
        }
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ext.name} — API Documentation</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; }
    h2 { color: #8b949e; margin-bottom: 1.5rem; }
    h3 { color: #58a6ff; margin: 1rem 0 0.5rem; }
    .tool { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { color: #8b949e; font-size: 0.85rem; }
    code { background: #1f2937; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9rem; }
    p { margin: 0.5rem 0; line-height: 1.6; }
    .badge { display: inline-block; background: #238636; color: #fff; padding: 0.1rem 0.5rem; border-radius: 12px; font-size: 0.75rem; }
    blockquote { border-left: 3px solid #30363d; padding-left: 1rem; color: #8b949e; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>${ext.name}</h1>
  ${ext.description ? `<blockquote>${ext.description}</blockquote>` : ""}
  <h2>API Documentation <span class="badge">${ext.tools.length} tool${ext.tools.length !== 1 ? "s" : ""}</span></h2>
  ${toolRows}
</body>
</html>`;
}

// ─── Coverage Validation ──────────────────────────────────────────────────────

interface CoverageReport {
  totalTools: number;
  documentedTools: number;
  coverage: number;
  meetsMinCoverage: boolean;
  minCoverage: number;
  undocumented: string[];
  details: Array<{ tool: string; hasDescription: boolean; documentedParams: number; totalParams: number }>;
}

/**
 * Validate documentation coverage for an extension.
 */
export function validateCoverage(ext: ParsedExtension, minCoverage: number): CoverageReport {
  const details: CoverageReport["details"] = [];
  const undocumented: string[] = [];

  for (const tool of ext.tools) {
    const hasDescription = tool.description.length > 0;
    const paramEntries = Object.entries(tool.parameters);
    const documentedParams = paramEntries.filter(([, p]) => p.description.length > 0).length;
    const totalParams = paramEntries.length;

    const toolCoverage =
      totalParams === 0
        ? hasDescription ? 1 : 0
        : (hasDescription ? 0.5 : 0) + 0.5 * (documentedParams / Math.max(totalParams, 1));

    details.push({ tool: tool.name, hasDescription, documentedParams, totalParams });

    if (toolCoverage < 0.5) {
      undocumented.push(tool.name);
    }
  }

  const documentedTools = ext.tools.length - undocumented.length;
  const coverage = ext.tools.length > 0 ? documentedTools / ext.tools.length : 1;

  return {
    totalTools: ext.tools.length,
    documentedTools,
    coverage,
    meetsMinCoverage: coverage >= minCoverage,
    minCoverage,
    undocumented,
    details,
  };
}

// ─── HTML Report for Coverage ─────────────────────────────────────────────────

function generateCoverageMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push("# Documentation Coverage Report");
  lines.push("");
  lines.push(`**Coverage:** ${(report.coverage * 100).toFixed(1)}% (${report.documentedTools}/${report.totalTools} tools)`);
  lines.push(`**Minimum required:** ${(report.minCoverage * 100).toFixed(0)}%`);
  lines.push(`**Status:** ${report.meetsMinCoverage ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");

  if (report.undocumented.length > 0) {
    lines.push("## Undocumented Tools");
    lines.push("");
    for (const name of report.undocumented) {
      lines.push(`- \`${name}\``);
    }
    lines.push("");
  }

  lines.push("## Details");
  lines.push("");
  lines.push("| Tool | Description | Params Documented |");
  lines.push("|------|-------------|-------------------|");
  for (const d of report.details) {
    lines.push(
      `| \`${d.tool}\` | ${d.hasDescription ? "✅" : "❌"} | ${d.documentedParams}/${d.totalParams} |`,
    );
  }

  return lines.join("\n");
}

// ─── Extension Registration ───────────────────────────────────────────────────

export default function register(pi: ExtensionAPI): void {
  // Tool 1: doc_generate
  pi.registerTool({
    name: "doc_generate",
    label: "Generate Documentation",
    description:
      "Generate API documentation from a pi.dev extension's source code. Parses TypeBox schemas from registerTool calls and produces Markdown or HTML documentation.",
    parameters: DocGenerateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sourceDir = path.resolve(params.source);
      const format = params.format ?? "markdown";
      const outputDir = path.resolve(params.output ?? "./docs");

      if (!fs.existsSync(sourceDir)) {
        return {
          content: [{ type: "text", text: `Error: Source directory not found: ${sourceDir}` }],
          details: { success: false, error: "directory_not_found" },
        };
      }

      const ext = parseExtensionSources(sourceDir);

      if (ext.tools.length === 0) {
        return {
          content: [{ type: "text", text: "No tools found in source directory. Ensure files contain registerTool() calls with TypeBox schemas." }],
          details: { success: false, error: "no_tools_found", tools: 0 },
        };
      }

      fs.mkdirSync(outputDir, { recursive: true });

      if (format === "markdown") {
        const md = generateMarkdown(ext);
        const outPath = path.join(outputDir, `${ext.name}.md`);
        fs.writeFileSync(outPath, md, "utf-8");
        return {
          content: [{ type: "text", text: `Generated Markdown docs for ${ext.name} (${ext.tools.length} tools) → ${outPath}` }],
          details: { success: true, format: "markdown", output: outPath, tools: ext.tools.length },
        };
      }

      const html = generateHTML(ext);
      const outPath = path.join(outputDir, `${ext.name}.html`);
      fs.writeFileSync(outPath, html, "utf-8");
      return {
        content: [{ type: "text", text: `Generated HTML docs for ${ext.name} (${ext.tools.length} tools) → ${outPath}` }],
        details: { success: true, format: "html", output: outPath, tools: ext.tools.length },
      };
    },
  });

  // Tool 2: doc_serve
  pi.registerTool({
    name: "doc_serve",
    label: "Serve Documentation",
    description:
      "Serve generated documentation locally as a simple HTTP server for browser preview.",
    parameters: DocServeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const docsDir = path.resolve(params.docs ?? "./docs");
      const port = params.port ?? 8080;

      if (!fs.existsSync(docsDir)) {
        return {
          content: [{ type: "text", text: `Error: Docs directory not found: ${docsDir}. Run doc_generate first.` }],
          details: { success: false, error: "directory_not_found" },
        };
      }

      // Check for at least one HTML file
      const files = fs.readdirSync(docsDir);
      const htmlFiles = files.filter((f) => f.endsWith(".html"));
      if (htmlFiles.length === 0) {
        return {
          content: [{ type: "text", text: `No HTML files found in ${docsDir}. Generate HTML docs first (format: "html").` }],
          details: { success: false, error: "no_html_files" },
        };
      }

      const server = http.createServer((req, res) => {
        const url = req.url === "/" ? `/${htmlFiles[0]}` : req.url;
        const filePath = path.join(docsDir, url ?? "");

        if (!fs.existsSync(filePath) || !filePath.startsWith(docsDir)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const ext = path.extname(filePath);
        const contentType =
          ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "text/plain";

        res.writeHead(200, { "Content-Type": contentType });
        res.end(fs.readFileSync(filePath));
      });

      return new Promise((resolve) => {
        server.listen(port, () => {
          const url = `http://localhost:${port}`;
          resolve({
            content: [{ type: "text", text: `Docs server running at ${url}\nServing ${htmlFiles.length} HTML file(s) from ${docsDir}\nPress Ctrl+C or stop the tool to shut down.` }],
            details: { success: true, url, port, files: htmlFiles },
          });

          // Auto-shutdown after 5 minutes
          setTimeout(() => server.close(), 5 * 60 * 1000);
        });
      });
    },
  });

  // Tool 3: doc_validate
  pi.registerTool({
    name: "doc_validate",
    label: "Validate Documentation Coverage",
    description:
      "Check that all registered tools in an extension have documentation coverage. Reports undocumented tools and overall coverage percentage.",
    parameters: DocValidateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sourceDir = path.resolve(params.source);
      const minCoverage = params.minCoverage ?? 0.8;

      if (!fs.existsSync(sourceDir)) {
        return {
          content: [{ type: "text", text: `Error: Source directory not found: ${sourceDir}` }],
          details: { success: false, error: "directory_not_found" },
        };
      }

      const ext = parseExtensionSources(sourceDir);

      if (ext.tools.length === 0) {
        return {
          content: [{ type: "text", text: "No tools found in source directory." }],
          details: { success: false, error: "no_tools_found" },
        };
      }

      const report = validateCoverage(ext, minCoverage);
      const md = generateCoverageMarkdown(report);

      return {
        content: [{ type: "text", text: md }],
        details: {
          success: true,
          coverage: report.coverage,
          meetsMinCoverage: report.meetsMinCoverage,
          totalTools: report.totalTools,
          documentedTools: report.documentedTools,
          undocumented: report.undocumented,
        },
      };
    },
  });
}
