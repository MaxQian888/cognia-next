/**
 * The check language the adherence backtest and live enforcement share
 * (ADR-0238 §8.2).
 *
 * A written rule becomes a check only when it is about observable tool use:
 * a call that must never happen (`forbid`), or a call that must follow
 * (`require-after`) or precede (`require-before`) another within the turn or
 * the session. The model proposes checks; this module decides whether they
 * are safe to run. Command patterns are regular expressions from a model, so
 * they are length-capped, rejected when they nest quantifiers (the shape that
 * backtracks catastrophically), and only ever run against a bounded prefix of
 * a command line.
 */

import type { NormalizedToolCall, ToolFamily } from "./events"

export type CheckKind = "forbid" | "require-after" | "require-before"
export type CheckScope = "turn" | "session"

export interface ToolMatcher {
  family: ToolFamily | "any"
  /** For edit and read calls: a glob over the path (`**`, `*`, `?`). */
  pathGlob?: string
  /** For shell calls: a regular expression over the command line. */
  command?: string
}

/** Where the rule a check came from is written. */
export interface RuleRef {
  surfaceKey: string
  surfaceName: string
  startLine: number
  endLine: number
  text: string
}

export interface RuleCheck {
  /** `CHK-` + hash of the rule and the check; stable across runs. */
  id: string
  kind: CheckKind
  trigger: ToolMatcher
  /** What must follow or precede the trigger; absent for `forbid`. */
  expect?: ToolMatcher
  scope: CheckScope
  /** One line saying what is checked, in the rule's language. */
  summary: string
  rule: RuleRef
}

export const MAX_PATTERN_CHARS = 200
export const MAX_GLOB_CHARS = 200
/** Commands longer than this are matched on their first part only. */
export const MAX_COMMAND_SCAN = 4_000

/** `(…+)+`, `(…*)*`, `(…+)*`, `(…{n,})+` and friends. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/
/** Back-references and lookbehind are not needed for a command shape. */
const UNSUPPORTED = /\\[1-9]|\(\?<[=!]/

export class UnsafePatternError extends Error {
  readonly code = "unsafe_pattern"
  constructor(
    readonly pattern: string,
    reason: string
  ) {
    super(`unsafe command pattern: ${reason}`)
    this.name = "UnsafePatternError"
  }
}

export function compileCommandPattern(pattern: string): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) {
    throw new UnsafePatternError(pattern, "empty or too long")
  }
  if (NESTED_QUANTIFIER.test(pattern)) throw new UnsafePatternError(pattern, "nested quantifier")
  if (UNSUPPORTED.test(pattern)) throw new UnsafePatternError(pattern, "unsupported construct")
  try {
    return new RegExp(pattern)
  } catch {
    throw new UnsafePatternError(pattern, "does not compile")
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/** A glob as an anchored regular expression; `**` crosses directories, `*` does not. */
export function globToRegExp(glob: string): RegExp {
  if (!glob || glob.length > MAX_GLOB_CHARS) throw new UnsafePatternError(glob, "bad glob")
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` matches zero or more directories.
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?"
          index += 2
        } else {
          source += ".*"
          index += 1
        }
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(`^${source}$`)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * Whether `path` matches `glob`. A glob without a slash matches the base name
 * (as in `.gitignore`); one with a slash matches the path relative to a
 * workspace root, or — for a path from a session run elsewhere — any suffix
 * of it that starts at a directory boundary.
 */
export function pathMatchesGlob(
  path: string,
  glob: string,
  roots: readonly string[] = []
): boolean {
  const pattern = globToRegExp(normalizePath(glob).replace(/^\//, ""))
  const normalized = normalizePath(path)
  if (!glob.includes("/")) {
    return pattern.test(normalized.split("/").pop() ?? normalized)
  }
  for (const root of roots) {
    const prefix = `${normalizePath(root).replace(/\/+$/, "")}/`
    if (normalized.startsWith(prefix)) return pattern.test(normalized.slice(prefix.length))
  }
  if (pattern.test(normalized)) return true
  const parts = normalized.split("/")
  for (let start = 1; start < parts.length; start++) {
    if (pattern.test(parts.slice(start).join("/"))) return true
  }
  return false
}

export interface CompiledMatcher {
  matches(call: NormalizedToolCall): boolean
}

export function compileMatcher(
  matcher: ToolMatcher,
  roots: readonly string[] = []
): CompiledMatcher {
  const command = matcher.command ? compileCommandPattern(matcher.command) : undefined
  if (matcher.pathGlob) globToRegExp(matcher.pathGlob) // validate up front
  return {
    matches(call) {
      if (matcher.family !== "any" && call.family !== matcher.family) return false
      if (command) {
        if (!call.command) return false
        if (!command.test(call.command.slice(0, MAX_COMMAND_SCAN))) return false
      }
      if (matcher.pathGlob) {
        const glob = matcher.pathGlob
        if (!call.paths.some((path) => pathMatchesGlob(path, glob, roots))) return false
      }
      return true
    },
  }
}

const FAMILIES: ReadonlySet<string> = new Set(["shell", "edit", "read", "other", "any"])

/** A matcher from untrusted JSON, or `undefined` when it is not runnable. */
export function parseMatcher(value: unknown): ToolMatcher | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const family = typeof row.family === "string" ? row.family : "any"
  if (!FAMILIES.has(family)) return undefined
  const matcher: ToolMatcher = { family: family as ToolMatcher["family"] }
  if (typeof row.pathGlob === "string" && row.pathGlob.trim())
    matcher.pathGlob = row.pathGlob.trim()
  if (typeof row.command === "string" && row.command.trim()) matcher.command = row.command.trim()
  // A matcher that matches every call of every tool is not a rule about anything.
  if (matcher.family === "any" && !matcher.pathGlob && !matcher.command) return undefined
  try {
    compileMatcher(matcher)
  } catch {
    return undefined
  }
  return matcher
}

/** A readable one-line form of a matcher, for the UI and the samples. */
export function describeMatcher(
  matcher: ToolMatcher,
  familyLabel: (family: ToolMatcher["family"]) => string = (family) => family
): string {
  const parts: string[] = [familyLabel(matcher.family)]
  if (matcher.pathGlob) parts.push(matcher.pathGlob)
  if (matcher.command) parts.push(`/${matcher.command}/`)
  return parts.join(" ")
}
