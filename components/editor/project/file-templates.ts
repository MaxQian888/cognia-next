// Starter content for the file tree's "New File from Template" flow.
//
// Templates are deliberately scaffolding-light: they write just enough that a
// file is *valid* for its format (an HTML skeleton, a runnable Python main,
// a Jest suite) without presuming the user's framework choices. The component
// name for .tsx derives from the final filename so renaming the file in the
// create input renames the export.

/** PascalCase identifier derived from a filename — `my-widget.tsx` → `MyWidget`. */
function componentNameFor(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName
  const stem = base.replace(/\.[^.]*$/, "")
  const parts = stem.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("")
  // A leading digit (or an all-symbol name) can't be an identifier.
  return /^[a-zA-Z_]/.test(name) ? name : "Component"
}

function titleFor(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName
  return base.replace(/\.[^.]*$/, "") || base
}

export interface FileTemplate {
  id: string
  /** i18n key under `projectEditor.templates`. */
  labelKey: string
  /** Filename the create input starts with — extension carries the intent. */
  suggestedName: string
  /** File body, given the name the user finally submits. */
  content: (fileName: string) => string
}

export const FILE_TEMPLATES: FileTemplate[] = [
  {
    id: "empty",
    labelKey: "empty",
    suggestedName: "",
    content: () => "",
  },
  {
    id: "typescript",
    labelKey: "typescript",
    suggestedName: "index.ts",
    content: () => "export {}\n",
  },
  {
    id: "reactComponent",
    labelKey: "reactComponent",
    suggestedName: "component.tsx",
    content: (fileName) =>
      `export function ${componentNameFor(fileName)}() {\n` +
      `  return <div>${componentNameFor(fileName)}</div>\n` +
      `}\n`,
  },
  {
    id: "test",
    labelKey: "test",
    suggestedName: "example.test.ts",
    content: (fileName) =>
      `import { describe, expect, it } from "vitest"\n\n` +
      `describe("${titleFor(fileName)}", () => {\n` +
      `  it("works", () => {\n` +
      `    expect(true).toBe(true)\n` +
      `  })\n` +
      `})\n`,
  },
  {
    id: "markdown",
    labelKey: "markdown",
    suggestedName: "README.md",
    content: (fileName) => `# ${titleFor(fileName)}\n`,
  },
  {
    id: "html",
    labelKey: "html",
    suggestedName: "index.html",
    content: (fileName) =>
      `<!doctype html>\n` +
      `<html lang="en">\n` +
      `  <head>\n` +
      `    <meta charset="utf-8" />\n` +
      `    <meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
      `    <title>${titleFor(fileName)}</title>\n` +
      `  </head>\n` +
      `  <body>\n` +
      `  </body>\n` +
      `</html>\n`,
  },
  {
    id: "css",
    labelKey: "css",
    suggestedName: "styles.css",
    content: () => "",
  },
  {
    id: "json",
    labelKey: "json",
    suggestedName: "data.json",
    content: () => "{\n  \n}\n",
  },
  {
    id: "python",
    labelKey: "python",
    suggestedName: "main.py",
    content: () => `def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n`,
  },
  {
    id: "shell",
    labelKey: "shell",
    suggestedName: "script.sh",
    content: () => "#!/usr/bin/env bash\nset -euo pipefail\n\n",
  },
]

export function templateById(id: string): FileTemplate {
  return FILE_TEMPLATES.find((t) => t.id === id) ?? FILE_TEMPLATES[0]
}
