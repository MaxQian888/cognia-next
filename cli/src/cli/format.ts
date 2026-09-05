/**
 * Output conventions shared by the `api` plane and the derived resource
 * commands, modelled on the resource CLIs this one is meant to feel like.
 *
 *   --format raw     compact JSON, one line, the shape a script pipes to jq
 *   --format json    indented JSON, the shape a human diffs
 *   --format pretty  a rendered table or key/value block
 *   -o, --output DIR write the result into a file under DIR instead of stdout
 *
 * The default is deliberate rather than fixed: an explicit `--format` always
 * wins, otherwise `-o` implies `raw` (a file is going to be re-read by a
 * program) and a bare terminal gets `pretty`. `--json` remains accepted and
 * means `--format raw`, so every script written against the older commands
 * keeps working.
 */

import fs from "node:fs"
import path from "node:path"

import type { ParsedArgs } from "./args"
import { boolFlag, stringFlag } from "./args"
import type { OutputSink } from "./output"

export const OUTPUT_FORMATS = ["raw", "json", "pretty"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Flags the CLI itself owns on every new command.
 *
 * The API plane derives one flag per request-body field, so it needs to know
 * which names are already spoken for. A field whose flag would land in here
 * keeps its wire name and is reachable through `--data`, and anything else
 * unrecognised is refused locally rather than sent to a host that answers
 * `additionalProperties: false` with a 422.
 */
export const GLOBAL_FLAG_NAMES: ReadonlySet<string> = new Set([
  "help",
  "version",
  "format",
  "output",
  "o",
  "endpoint",
  "profile",
  "host",
  "tenant",
  "timeout",
  "debug",
  "json",
  "data",
  "wait",
  "template",
  "yes",
  "idempotency-key",
])

export interface OutputOptions {
  format: OutputFormat
  /** Directory for `-o`. Absent means stdout. */
  outputDir?: string
  debug: boolean
  timeoutMs: number
}

/**
 * `30s`, `1m`, `500ms`, `2h`, or a bare number read as seconds.
 * Returns undefined for anything else so the caller can refuse with a fix line
 * rather than silently falling back to a default the operator did not choose.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim())
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  switch (match[2]) {
    case "ms":
      return Math.round(value)
    case "m":
      return Math.round(value * 60_000)
    case "h":
      return Math.round(value * 3_600_000)
    default:
      return Math.round(value * 1000)
  }
}

export function resolveOutputOptions(
  args: ParsedArgs,
  env: Record<string, string | undefined> = process.env
): OutputOptions | { error: string; fix: string } {
  const outputDir = stringFlag(args, "output") ?? stringFlag(args, "o")
  const explicit = stringFlag(args, "format")

  let format: OutputFormat
  if (explicit !== undefined) {
    if (!(OUTPUT_FORMATS as readonly string[]).includes(explicit)) {
      return {
        error: `unknown --format "${explicit}"`,
        fix: `use one of: ${OUTPUT_FORMATS.join(", ")}`,
      }
    }
    format = explicit as OutputFormat
  } else if (boolFlag(args, "json")) {
    format = "raw"
  } else {
    format = outputDir ? "raw" : "pretty"
  }

  const timeoutText = stringFlag(args, "timeout") ?? env.COGNIA_TIMEOUT
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (timeoutText !== undefined) {
    const parsed = parseDuration(timeoutText)
    if (parsed === undefined) {
      return {
        error: `unreadable --timeout "${timeoutText}"`,
        fix: "use a duration such as 30s, 1m, or 500ms (a bare number means seconds)",
      }
    }
    timeoutMs = parsed
  }

  return {
    format,
    ...(outputDir ? { outputDir } : {}),
    debug: boolFlag(args, "debug"),
    timeoutMs,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function scalarText(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)
}

/** Column-aligned table for an array of flat-ish objects. */
export function renderTable(rows: Array<Record<string, unknown>>): string {
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }
  if (columns.length === 0) return ""
  const cells = rows.map((row) => columns.map((column) => scalarText(row[column])))
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index].length))
  )
  const line = (values: string[]) =>
    values
      .map((value, index) => (index === values.length - 1 ? value : value.padEnd(widths[index])))
      .join("  ")
      .trimEnd()
  return [line(columns), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join(
    "\n"
  )
}

/** Key/value block for one object, recursing into nested objects. */
function renderObject(value: Record<string, unknown>, indent = ""): string {
  const keys = Object.keys(value)
  if (keys.length === 0) return `${indent}(empty)`
  const width = Math.max(...keys.map((key) => key.length))
  const lines: string[] = []
  for (const key of keys) {
    const child = value[key]
    if (isScalar(child)) {
      lines.push(`${indent}${key.padEnd(width)}  ${scalarText(child)}`)
    } else if (Array.isArray(child) && child.every(isScalar)) {
      lines.push(`${indent}${key.padEnd(width)}  ${child.map(scalarText).join(", ")}`)
    } else if (Array.isArray(child) && child.every(isPlainObject) && child.length > 0) {
      lines.push(`${indent}${key}:`)
      lines.push(
        renderTable(child as Array<Record<string, unknown>>)
          .split("\n")
          .map((row) => `${indent}  ${row}`)
          .join("\n")
      )
    } else if (isPlainObject(child)) {
      lines.push(`${indent}${key}:`)
      lines.push(renderObject(child, `${indent}  `))
    } else {
      lines.push(`${indent}${key.padEnd(width)}  ${JSON.stringify(child)}`)
    }
  }
  return lines.join("\n")
}

export function renderValue(value: unknown, format: OutputFormat): string {
  if (format === "raw") return `${JSON.stringify(value)}\n`
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`
  if (value === undefined) return ""
  if (isScalar(value)) return `${scalarText(value)}\n`
  if (Array.isArray(value)) {
    if (value.length === 0) return "(no results)\n"
    if (value.every(isPlainObject)) {
      return `${renderTable(value as Array<Record<string, unknown>>)}\n`
    }
    return `${value.map(scalarText).join("\n")}\n`
  }
  if (isPlainObject(value)) return `${renderObject(value)}\n`
  return `${JSON.stringify(value, null, 2)}\n`
}

export interface EmitDeps {
  writeFile?: (absolutePath: string, contents: string) => void
  mkdir?: (absolutePath: string) => void
  resolve?: (...segments: string[]) => string
}

/**
 * Send one result to stdout, or to `<outputDir>/<basename>.json` when `-o` is
 * set. The file always carries the `format`-rendered text, so `-o` plus
 * `--format pretty` writes the table a human asked for rather than quietly
 * switching back to JSON.
 */
export function emitResult(
  out: OutputSink,
  value: unknown,
  options: OutputOptions,
  basename: string,
  deps: EmitDeps = {}
): string | undefined {
  const text = renderValue(value, options.format)
  if (!options.outputDir) {
    out.write(text)
    return undefined
  }
  const resolve = deps.resolve ?? ((...segments: string[]) => path.resolve(...segments))
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }))
  const writeFile =
    deps.writeFile ?? ((file: string, contents: string) => fs.writeFileSync(file, contents))
  const extension = options.format === "pretty" ? "txt" : "json"
  const target = resolve(options.outputDir, `${basename}.${extension}`)
  mkdir(options.outputDir)
  writeFile(target, text)
  return target
}
