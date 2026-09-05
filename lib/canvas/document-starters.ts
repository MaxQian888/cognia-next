/**
 * Starter bodies for a new Canvas document.
 *
 * Not the unified template platform (ADR-0100), and deliberately so: that
 * platform exists for templates that are installed, shared, versioned and
 * parameterised with `{{placeholders}}`. A Canvas starter is none of those. It
 * is a few lines of the right shape so a new document does not open as a blank
 * rectangle, and it must not leave `${1:name}`-style tokens in the buffer the
 * way the editor snippet registry would.
 *
 * Every starter is valid in its own language, so a new document can be
 * previewed or run immediately.
 */

import type { ArtifactLanguage } from "@/types"

export interface CanvasDocumentStarter {
  /** Stable id, also the i18n key under `canvas.newDocument.starters`. */
  id: string
  language: ArtifactLanguage
  type: "code" | "text"
  content: string
}

/**
 * The empty document. Kept in the list rather than special-cased, so "start
 * from nothing" is a visible choice rather than the absence of one.
 */
export const EMPTY_STARTER_ID = "empty"

const STARTERS: CanvasDocumentStarter[] = [
  {
    id: "markdown-notes",
    language: "markdown",
    type: "text",
    content: ["# Title", "", "Write here.", "", "## Section", "", "- point", "- point", ""].join(
      "\n"
    ),
  },
  {
    id: "markdown-spec",
    language: "markdown",
    type: "text",
    content: [
      "# Title",
      "",
      "## Context",
      "",
      "What is true today, and why it is a problem.",
      "",
      "## Decision",
      "",
      "What we are doing about it.",
      "",
      "## Consequences",
      "",
      "What this costs, and what it rules out.",
      "",
    ].join("\n"),
  },
  {
    id: "javascript-module",
    language: "javascript",
    type: "code",
    content: ["export function main() {", '  console.log("hello")', "}", "", "main()", ""].join(
      "\n"
    ),
  },
  {
    id: "typescript-module",
    language: "typescript",
    type: "code",
    content: [
      "export interface Options {",
      "  name: string",
      "}",
      "",
      "export function main(options: Options): string {",
      "  return `hello ${options.name}`",
      "}",
      "",
    ].join("\n"),
  },
  {
    id: "python-script",
    language: "python",
    type: "code",
    content: [
      "def main() -> None:",
      '    print("hello")',
      "",
      "",
      'if __name__ == "__main__":',
      "    main()",
      "",
    ].join("\n"),
  },
  {
    id: "html-page",
    language: "html",
    type: "code",
    content: [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <title>Page</title>",
      "  </head>",
      "  <body>",
      "    <h1>Hello</h1>",
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  },
  {
    id: "svg-drawing",
    language: "svg",
    type: "code",
    content: [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">',
      '  <rect x="20" y="20" width="160" height="80" rx="8" fill="none" stroke="currentColor" />',
      "</svg>",
      "",
    ].join("\n"),
  },
  {
    id: "mermaid-diagram",
    language: "mermaid",
    type: "code",
    content: [
      "flowchart LR",
      "  A[Start] --> B{Decision}",
      "  B -->|yes| C[Done]",
      "  B -->|no| A",
      "",
    ].join("\n"),
  },
  {
    id: "json-document",
    language: "json",
    type: "code",
    content: ["{", '  "name": "untitled",', '  "items": []', "}", ""].join("\n"),
  },
]

/**
 * Starters offered for a language, empty first.
 *
 * A language with no starter of its own still gets the empty choice, so the
 * picker never renders as a dead control.
 */
export function startersForLanguage(language: ArtifactLanguage): CanvasDocumentStarter[] {
  return STARTERS.filter((starter) => starter.language === language)
}

export function findStarter(id: string): CanvasDocumentStarter | undefined {
  return STARTERS.find((starter) => starter.id === id)
}

/** Every starter, for the coverage test that pins the i18n keys. */
export function allStarters(): readonly CanvasDocumentStarter[] {
  return STARTERS
}

/**
 * The document type a language implies when no starter is chosen. Markdown and
 * LaTeX are writing surfaces. Everything else in the picker is code.
 */
export function defaultTypeForLanguage(language: ArtifactLanguage): "code" | "text" {
  return language === "markdown" || language === "latex" ? "text" : "code"
}
