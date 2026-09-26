// Structural scan for destructive shell fragments. Unlike the regex scan in
// ./rules.ts, parsing distinguishes a real redirect or nested command from the
// same text inside a quoted argument. `unbash` is a parser, not a policy
// engine; the allow/block decisions stay explicit here.

import { parse as parseBash } from "unbash"

import { DANGEROUS_PATTERNS } from "./rules.ts"

export interface DangerousFragment {
  fragment: string
  kind: "command" | "deviceRedirect"
}

const DESTRUCTIVE_SHELL_COMMANDS: ReadonlySet<unknown> = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "format",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
])

const SAFE_DEVICE_REDIRECT = /^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/
const WRITE_REDIRECTS: ReadonlySet<unknown> = new Set([">", ">>", ">|", "<>", "&>", "&>>"])

/** A source span in the AST. */
interface Span {
  value?: unknown
  pos?: number
  end?: number
}

/**
 * The fields the scan reads from any AST node. The walk is generic over
 * `unbash`'s node kinds, so nodes are read through this one loose shape.
 */
interface ScannedNode extends Span {
  type?: unknown
  name?: Span
  operator?: unknown
  target?: Span
  parts?: unknown
  indexParts?: unknown
}

function regexFallback(source: string): DangerousFragment | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    const match = source.match(pattern)
    if (match) return { fragment: match[0], kind: "command" }
  }
  return null
}

/** Parse a Bash command and return the first structurally dangerous fragment. */
export function findDangerousShellFragment(source: unknown): DangerousFragment | null {
  if (typeof source !== "string" || source.length === 0) return null

  let script: ReturnType<typeof parseBash>
  try {
    script = parseBash(source)
  } catch {
    // A parser failure must not weaken the existing defence-in-depth rule.
    return regexFallback(source)
  }

  let found: DangerousFragment | null = null
  const seen = new WeakSet<object>()

  const visit = (value: unknown): void => {
    if (found || value == null || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    const node = value as ScannedNode

    if (node.type === "Command") {
      const commandName = node.name?.value
      if (typeof commandName === "string" && DESTRUCTIVE_SHELL_COMMANDS.has(commandName)) {
        const nameStart = node.name?.pos ?? node.pos ?? 0
        const boundary = source.slice(0, nameStart).match(/(?:&&|\|\||[;|])\s*$/)
        found = {
          fragment: source.slice(
            boundary ? nameStart - boundary[0].length : nameStart,
            node.name?.end ?? node.end
          ),
          kind: "command",
        }
        return
      }
    }

    if (WRITE_REDIRECTS.has(node.operator) && node.target) {
      const target = node.target.value
      if (
        typeof target === "string" &&
        target.startsWith("/dev/") &&
        !SAFE_DEVICE_REDIRECT.test(target)
      ) {
        found = {
          fragment: source.slice(node.pos ?? node.target.pos ?? 0, node.end ?? node.target.end),
          kind: "deviceRedirect",
        }
        return
      }
    }

    for (const child of Object.values(value)) visit(child)
    // Word expansion parts are deliberately lazy/non-enumerable in unbash, so
    // read them explicitly to reach $(...), backticks, and nested redirects.
    try {
      if (Array.isArray(node.parts)) visit(node.parts)
      if (Array.isArray(node.indexParts)) visit(node.indexParts)
    } catch {
      // Malformed lazy expansion: the root/partial AST is still useful.
    }
  }

  visit(script)
  if (found) return found

  // Tolerant parsing can return a partial AST. Preserve the old fail-closed
  // scan only for malformed input; valid quoted text never reaches this path.
  if (Array.isArray(script.errors) && script.errors.length > 0) return regexFallback(source)
  return null
}
