/**
 * Decides how a string tool result should be rendered in the tool card.
 *
 * Terminal tools emit plain text, and Markdown is a lossy container for it:
 * single newlines reflow into paragraphs, `<sys/stat.h>` is parsed as raw HTML
 * and sanitized away, and any 4-space-indented output becomes a nested code
 * block. `cat`-ing a source file through Bash hit all three at once, so a
 * terminal result always renders as a code block instead — syntax-highlighted
 * when the command names a file we can key a language off.
 *
 * Kept framework-free so it is trivially unit-testable; `ai-elements/tool.tsx`
 * is a vendored file excluded from coverage and only consumes this.
 */

import { bareToolName } from "./tool-summary"

export type ToolOutputRender =
  /** Preformatted code block; `language` enables syntax highlighting when known. */
  { kind: "code"; language?: string } | { kind: "markdown" }

/** Bare names (post `tool-` / `mcp__<server>__` folding) whose output is a terminal stream. */
const TERMINAL_TOOLS = new Set(["Bash", "bash"])

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
}

/** Map a file path's extension to a Shiki language id. */
export function inferLanguageFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined
  const ext = filePath.split(".").pop()?.toLowerCase()
  if (!ext || ext === filePath.toLowerCase()) return undefined
  return EXT_TO_LANG[ext]
}

/**
 * Commands whose stdout is the verbatim contents of the file arguments that
 * follow — so the file's extension identifies the language of the output.
 * Covers POSIX, cmd (`type`) and PowerShell (`Get-Content` and its aliases).
 * `echo`/`grep` are deliberately absent: they may *mention* a path without
 * their output being that file.
 */
const FILE_DUMP_COMMANDS = new Set([
  "cat",
  "bat",
  "batcat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "type",
  "get-content",
  "gc",
])

/** Split on the shell operators that separate one command from the next. */
function splitCommandSegments(command: string): string[] {
  return command.split(/\|\||&&|[|;\n]/)
}

/** Strip a directory prefix and a Windows `.exe` suffix from a command word. */
function commandHead(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.replace(/\.exe$/i, "").toLowerCase()
}

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, "")
}

/**
 * Naive tokenizer: good enough to spot `cat <path>`. Quoted paths containing
 * spaces are re-joined; anything more exotic simply yields no language, which
 * degrades to an unhighlighted (but still faithful) code block.
 */
function tokenize(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

/**
 * Infer one language for a shell command's stdout by looking at the files it
 * dumps. Returns undefined unless every dumped file agrees — `cat a.cpp && cat
 * b.ts` has no single right answer, so it stays unhighlighted.
 */
export function inferShellOutputLanguage(command: string): string | undefined {
  const languages = new Set<string>()

  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenize(segment.trim())
    if (tokens.length === 0) continue
    if (!FILE_DUMP_COMMANDS.has(commandHead(unquote(tokens[0])))) continue

    for (const raw of tokens.slice(1)) {
      const token = unquote(raw)
      // Flags (`-80`, `-n`, `--lines=5`) and their numeric values are not paths.
      if (token.startsWith("-") || /^\d+$/.test(token)) continue
      const language = inferLanguageFromPath(token)
      if (language) languages.add(language)
    }
  }

  return languages.size === 1 ? [...languages][0] : undefined
}

/** Well-formed JSON objects/arrays get syntax highlighting regardless of tool. */
function looksLikeJson(s: string): boolean {
  const trimmed = s.trim()
  if (!trimmed) return false
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
}

function commandOf(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command
    if (typeof command === "string") return command
  }
  return undefined
}

/**
 * @param output   The raw string tool result.
 * @param toolType The part type (e.g. `tool-Bash`), or undefined when unknown.
 * @param input    The tool-call input; a terminal tool's `command` keys the language.
 */
export function resolveToolOutputRender(
  output: string,
  toolType?: string,
  input?: unknown
): ToolOutputRender {
  if (toolType && TERMINAL_TOOLS.has(bareToolName(toolType))) {
    const command = commandOf(input)
    // The dumped file's extension beats sniffing the bytes; the JSON sniff is
    // the fallback for commands that emit JSON without naming a file (`curl`).
    const language =
      (command ? inferShellOutputLanguage(command) : undefined) ??
      (looksLikeJson(output) ? "json" : undefined)
    return language ? { kind: "code", language } : { kind: "code" }
  }

  if (looksLikeJson(output)) return { kind: "code", language: "json" }
  return { kind: "markdown" }
}
