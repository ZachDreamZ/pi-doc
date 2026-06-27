import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseExtensionSources,
  generateMarkdown,
  generateHTML,
  validateCoverage,
  type ParsedExtension,
  type PropertyInfo,
} from "../extensions/index.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-doc-test-"));
}

function writeTmpFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const SIMPLE_EXTENSION = `
import { Type } from "@sinclair/typebox";

/** A test extension for unit tests */
pi.registerTool({
  name: "hello_world",
  description: "Say hello to someone",
  parameters: Type.Object({
    name: Type.String({ description: "The name to greet" }),
    greeting: Type.Optional(Type.String({ description: "Custom greeting" })),
  }),
  async execute() { return { content: [] }; },
});
`;

const MULTI_TOOL_EXTENSION = `
import { Type } from "@sinclair/typebox";

pi.registerTool({
  name: "tool_alpha",
  description: "First tool",
  parameters: Type.Object({
    input: Type.String({ description: "Input data" }),
    count: Type.Number({ description: "Number of iterations", minimum: 1, maximum: 100 }),
  }),
  async execute() { return { content: [] }; },
});

pi.registerTool({
  name: "tool_beta",
  description: "Second tool",
  parameters: Type.Object({
    flag: Type.Boolean({ description: "Enable feature" }),
  }),
  async execute() { return { content: [] }; },
});
`;

const NO_DOCS_EXTENSION = `
import { Type } from "@sinclair/typebox";

pi.registerTool({
  name: "undocumented_tool",
  parameters: Type.Object({
    value: Type.String(),
  }),
  async execute() { return { content: [] }; },
});
`;

describe("parseExtensionSources", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a single-tool extension", () => {
    writeTmpFile(tmpDir, "index.ts", SIMPLE_EXTENSION);
    const ext = parseExtensionSources(tmpDir);

    expect(ext.tools).toHaveLength(1);
    expect(ext.tools[0].name).toBe("hello_world");
    expect(ext.tools[0].description).toBe("Say hello to someone");
  });

  it("extracts parameters with descriptions", () => {
    writeTmpFile(tmpDir, "index.ts", SIMPLE_EXTENSION);
    const ext = parseExtensionSources(tmpDir);
    const params = ext.tools[0].parameters;

    expect(params.name).toBeDefined();
    expect(params.name.type).toBe("string");
    expect(params.name.description).toBe("The name to greet");
    expect(params.name.required).toBe(true);
  });

  it("identifies optional parameters", () => {
    writeTmpFile(tmpDir, "index.ts", SIMPLE_EXTENSION);
    const ext = parseExtensionSources(tmpDir);
    const params = ext.tools[0].parameters;

    expect(params.greeting).toBeDefined();
    expect(params.greeting.required).toBe(false);
  });

  it("parses multi-tool extensions", () => {
    writeTmpFile(tmpDir, "index.ts", MULTI_TOOL_EXTENSION);
    const ext = parseExtensionSources(tmpDir);

    expect(ext.tools).toHaveLength(2);
    expect(ext.tools[0].name).toBe("tool_alpha");
    expect(ext.tools[1].name).toBe("tool_beta");
  });

  it("extracts number parameters with min/max", () => {
    writeTmpFile(tmpDir, "index.ts", MULTI_TOOL_EXTENSION);
    const ext = parseExtensionSources(tmpDir);
    const countParam = ext.tools[0].parameters.count;

    expect(countParam.type).toBe("number");
    expect(countParam.minimum).toBe(1);
    expect(countParam.maximum).toBe(100);
  });

  it("returns empty tools for no-registerTool files", () => {
    writeTmpFile(tmpDir, "empty.ts", "export const x = 1;");
    const ext = parseExtensionSources(tmpDir);
    expect(ext.tools).toHaveLength(0);
  });

  it("handles non-existent directories gracefully", () => {
    const ext = parseExtensionSources("/nonexistent/path");
    expect(ext.tools).toHaveLength(0);
  });

  it("recursively finds .ts files in subdirectories", () => {
    writeTmpFile(tmpDir, "src/tools/greet.ts", SIMPLE_EXTENSION);
    const ext = parseExtensionSources(tmpDir);
    expect(ext.tools).toHaveLength(1);
  });

  it("skips node_modules and dist directories", () => {
    writeTmpFile(tmpDir, "node_modules/foo/index.ts", SIMPLE_EXTENSION);
    writeTmpFile(tmpDir, "dist/index.ts", SIMPLE_EXTENSION);
    writeTmpFile(tmpDir, "index.ts", SIMPLE_EXTENSION);
    const ext = parseExtensionSources(tmpDir);
    expect(ext.tools).toHaveLength(1);
  });
});

describe("generateMarkdown", () => {
  it("generates correct markdown for a single tool", () => {
    const ext = {
      name: "test-ext",
      description: "A test extension",
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          parameters: { name: { type: "string", description: "Name", required: true } as PropertyInfo },
          required: ["name"],
        },
      ],
    };

    const md = generateMarkdown(ext as ParsedExtension);

    expect(md).toContain("# test-ext");
    expect(md).toContain("> A test extension");
    expect(md).toContain("### `greet`");
    expect(md).toContain("Greet someone");
    expect(md).toContain("`name`");
    expect(md).toContain("string");
  });

  it("shows required vs optional labels", () => {
    const md = generateMarkdown({
      name: "test",
      description: "",
      tools: [
        {
          name: "t",
          description: "",
          parameters: {
            req: { type: "string", description: "", required: true },
            opt: { type: "number", description: "", required: false },
          },
          required: ["req"],
        },
      ],
    });

    expect(md).toContain("required");
    expect(md).toContain("optional");
  });

  it("handles tools with no parameters", () => {
    const md = generateMarkdown({
      name: "test",
      description: "",
      tools: [{ name: "noop", description: "No-op tool", parameters: {}, required: [] }],
    });

    expect(md).toContain("No parameters");
  });
});

describe("generateHTML", () => {
  it("generates valid HTML structure", () => {
    const html = generateHTML({
      name: "test-ext",
      description: "A test",
      tools: [
        {
          name: "greet",
          description: "Say hi",
          parameters: { name: { type: "string", description: "Name", required: true } },
          required: ["name"],
        },
      ],
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test-ext");
    expect(html).toContain("greet");
    expect(html).toContain("<table>");
    expect(html).toContain("Say hi");
  });

  it("includes dark theme styling", () => {
    const html = generateHTML({
      name: "test",
      description: "",
      tools: [],
    });

    expect(html).toContain("#0d1117");
    expect(html).toContain("#58a6ff");
  });
});

describe("validateCoverage", () => {
  it("reports 100% coverage for fully documented tools", () => {
    const ext = {
      name: "test",
      description: "",
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          parameters: { name: { type: "string", description: "Name", required: true } },
          required: ["name"],
        },
      ],
    };

    const report = validateCoverage(ext, 0.8);

    expect(report.coverage).toBe(1);
    expect(report.meetsMinCoverage).toBe(true);
    expect(report.undocumented).toHaveLength(0);
  });

  it("flags undocumented tools", () => {
    const ext: ParsedExtension = {
      name: "test",
      description: "",
      tools: [
        {
          name: "good_tool",
          description: "Well documented",
          parameters: { x: { type: "string", description: "X", required: true } },
          required: ["x"],
        },
        {
          name: "bad_tool",
          description: "",
          parameters: { y: { type: "string", description: "", required: true } },
          required: ["y"],
        },
      ],
    };

    const report = validateCoverage(ext, 0.8);

    expect(report.coverage).toBe(0.5);
    expect(report.meetsMinCoverage).toBe(false);
    expect(report.undocumented).toContain("bad_tool");
  });

  it("returns 100% for empty extension", () => {
    const report = validateCoverage(
      { name: "test", description: "", tools: [] } as ParsedExtension,
      0.8,
    );
    expect(report.coverage).toBe(1);
  });

  it("tracks documented vs total params", () => {
    const ext: ParsedExtension = {
      name: "test",
      description: "",
      tools: [
        {
          name: "partial",
          description: "Has description",
          parameters: {
            a: { type: "string", description: "Documented", required: true },
            b: { type: "number", description: "", required: false },
          },
          required: ["a"],
        },
      ],
    };

    const report = validateCoverage(ext, 0.5);
    expect(report.details[0].documentedParams).toBe(1);
    expect(report.details[0].totalParams).toBe(2);
  });
});
