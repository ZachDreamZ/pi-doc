# pi-doc

> API documentation generator for pi.dev extensions — parse TypeBox schemas and generate Markdown/HTML docs.

## Installation

```bash
pi install npm:pi-doc
```

## What It Does

pi-doc generates API documentation from pi.dev extension source code. It parses TypeBox schema definitions from `registerTool()` calls, extracts tool names, parameter types, descriptions, and required fields, then produces clean Markdown or HTML documentation.

**Three tools:**
- **doc_generate** — Parse TypeBox schemas and generate Markdown/HTML docs
- **doc_serve** — Serve generated docs locally for browser preview
- **doc_validate** — Check documentation coverage against registered tools

## Tools

### `doc_generate`

Generate API documentation from a pi.dev extension's source code.

**Parameters:**
- `source` (string, required) — Path to the extension directory containing TypeScript source files
- `format` (string, optional, default: "markdown") — Output format: `markdown` or `html`
- `output` (string, optional, default: "./docs") — Output directory for generated docs

**Example:**
```
Use the doc_generate tool with source="./extensions", format="html", output="./docs"
```

### `doc_serve`

Serve generated documentation locally as a simple HTTP server.

**Parameters:**
- `docs` (string, optional, default: "./docs") — Path to the docs directory to serve
- `port` (number, optional, default: 8080) — Port to serve on

**Example:**
```
Use the doc_serve tool with docs="./docs", port=3000
```

### `doc_validate`

Check that all registered tools have documentation coverage.

**Parameters:**
- `source` (string, required) — Path to the extension directory to validate
- `minCoverage` (number, optional, default: 0.8) — Minimum coverage ratio required (0-1)

**Example:**
```
Use the doc_validate tool with source="./extensions", minCoverage=0.9
```

## Resources

- [npm](https://www.npmjs.com/package/pi-doc)
- [GitHub](https://github.com/ZachDreamZ/pi-doc)
- [pi.dev](https://pi.dev/packages/pi-doc)

## License

MIT
