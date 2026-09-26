// Sidecar-side glob permission resolver — the JS mirror of
// `lib/claude/permissions/ruleset.ts`, consulted by the permission ladder
// (`./ladder.ts`) to short-circuit the `permission_request` round-trip when
// the renderer pre-resolved an *explicit* allow/deny rule for a tool call.
//
// Deliberately narrow: it only acts on EXPLICIT matches in the serialized
// ruleset (no baked-in `*: allow` default — that would silently bypass every
// approval). A non-match resolves to "ask", which means "fall through to the
// normal round-trip". The rich, compound-command-aware classifier + model
// judge live renderer-side (the Auto-mode Layer B in use-claude-chat); this
// fast-path only honors the static rules the user/character/plugin configured.

import { extractSubstitutions, splitTopLevel } from "../shell/segments.ts"

export type Verdict = "allow" | "ask" | "deny"

/**
 * A serialized permission ruleset: a verdict per tool, or glob → verdict per
 * tool, with `"*"` as the any-tool key. It arrives from the renderer
 * unchecked, so entries that are not verdicts are skipped.
 */
export type PermissionRuleset = Record<string, unknown>

const VERDICTS: ReadonlySet<unknown> = new Set(["allow", "ask", "deny"])
const VERDICT_RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 }

function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.has(value)
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
      } else {
        re += "[^/\\\\]*"
      }
    } else if (c === "?") {
      re += "[^/\\\\]"
    } else {
      re += escapeRegex(c)
    }
  }
  return new RegExp(`^${re}$`)
}

const regexCache = new Map<string, RegExp>()
function cachedRegex(glob: string): RegExp {
  let r = regexCache.get(glob)
  if (!r) {
    r = globToRegExp(glob)
    regexCache.set(glob, r)
  }
  return r
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

export function matchGlob(glob: string, target: string): boolean {
  const re = cachedRegex(glob)
  if (re.test(target)) return true
  if (!glob.includes("/") && !glob.includes("\\")) return re.test(basename(target))
  return false
}

function specificity(glob: string): number {
  let n = 0
  for (const c of glob) if (c !== "*" && c !== "?") n++
  return n
}

/**
 * Resolve a single (tool, target) against the ruleset. Returns the matched
 * verdict ("allow"|"ask"|"deny"), or `null` when no rule matched.
 */
export function resolveToolVerdict(
  ruleset: unknown,
  toolName: string,
  target: string | undefined
): Verdict | null {
  if (!ruleset || typeof ruleset !== "object") return null
  const rules = ruleset as PermissionRuleset
  let best: RuleMatch | null = null
  for (const toolKey of [toolName, "*"]) {
    const entry = rules[toolKey]
    if (entry == null) continue
    const toolScore = toolKey === toolName ? 2 : 1
    if (typeof entry === "string") {
      if (isVerdict(entry)) best = better(best, { toolScore, globScore: 0, verdict: entry })
    } else if (typeof entry === "object") {
      for (const [glob, verdict] of Object.entries(entry)) {
        if (!isVerdict(verdict)) continue
        if (matchGlob(glob, target ?? "")) {
          best = better(best, { toolScore, globScore: specificity(glob), verdict })
        }
      }
    }
  }
  return best ? best.verdict : null
}

interface RuleMatch {
  toolScore: number
  globScore: number
  verdict: Verdict
}

function better(a: RuleMatch | null, b: RuleMatch): RuleMatch {
  if (!a) return b
  if (b.toolScore !== a.toolScore) return b.toolScore > a.toolScore ? b : a
  return b.globScore >= a.globScore ? b : a
}

/**
 * Byte-for-byte mirror of `readAnsiCQuote` in
 * `lib/claude/permissions/command-parse.ts`.
 */
function readAnsiCQuote(segment: string, start: number): { text: string; next: number } {
  let out = ""
  let i = start + 2
  while (i < segment.length && segment[i] !== "'") {
    if (segment[i] !== "\\") {
      out += segment[i]
      i++
      continue
    }
    const esc = segment[i + 1]
    i += 2
    switch (esc) {
      case "n":
        out += "\n"
        break
      case "t":
        out += "\t"
        break
      case "r":
        out += "\r"
        break
      case "a":
        out += "\x07"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "v":
        out += "\v"
        break
      case "e":
        out += "\x1b"
        break
      case "\\":
        out += "\\"
        break
      case "'":
        out += "'"
        break
      case '"':
        out += '"'
        break
      case "x": {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(segment.slice(i))?.[0]
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += hex.length
        } else out += "x"
        break
      }
      case "u": {
        const hex = /^[0-9a-fA-F]{1,4}/.exec(segment.slice(i))?.[0]
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += hex.length
        } else out += "u"
        break
      }
      default: {
        if (esc !== undefined && esc >= "0" && esc <= "7") {
          const oct = /^[0-7]{0,2}/.exec(segment.slice(i))?.[0] ?? ""
          out += String.fromCharCode(parseInt(esc + oct, 8))
          i += oct.length
        } else if (esc !== undefined) {
          out += esc
        }
      }
    }
  }
  return { text: out, next: i + 1 }
}

/**
 * Mirror of `canonicalizeCommand` in `lib/claude/permissions/command-parse.ts`
 * — the single spelling the shell would actually run. Used ONLY as a deny
 * probe: it may add a refusal a respelt command dodged, never satisfy an
 * allow. `ruleset.sidecar-parity.test.ts` pins the two implementations
 * together.
 */
export function canonicalizeCommand(command: string | null | undefined): string {
  const text = command ?? ""
  let out = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else out += c
      continue
    }
    if (inDouble) {
      const next = text[i + 1]
      if (c === "\\" && next !== undefined && '$`"\\'.includes(next)) {
        out += next
        i++
      } else if (c === '"') inDouble = false
      else out += c
      continue
    }
    if (c === "$" && text[i + 1] === "'") {
      const { text: decoded, next } = readAnsiCQuote(text, i)
      out += decoded
      i = next - 1
      continue
    }
    if (c === "'") {
      inSingle = true
      continue
    }
    if (c === '"') {
      inDouble = true
      continue
    }
    if (c === "\\" && text[i + 1] !== undefined) {
      out += text[i + 1]
      i++
      continue
    }
    out += c
  }
  return out.replace(/\s+/g, " ").trim()
}

const MAX_SPLIT_DEPTH = 20

function collectSegments(command: string, out: string[], depth: number): void {
  if (depth > MAX_SPLIT_DEPTH) return
  for (const raw of splitTopLevel(command)) {
    const trimmed = raw.trim()
    if (trimmed) out.push(trimmed)
    const { inner } = extractSubstitutions(raw)
    for (const sub of inner) {
      if (sub.trim()) collectSegments(sub, out, depth + 1)
    }
  }
}

/**
 * Split a Bash target into the segments the rules are matched against.
 *
 * Quote- and depth-aware, and it recursively surfaces commands hidden inside
 * `$(...)`, backticks, and subshells — the mirror of `splitCommandSegments` in
 * `lib/claude/permissions/command-parse.ts`, pinned by
 * `lib/claude/permissions/ruleset.sidecar-parity.test.ts`.
 *
 * The previous version split on a bare `/&&|\|\||;|\n|\|/`, which meant a
 * denied command wrapped in a substitution (`echo $(git push)`) produced one
 * segment that matched no rule, resolved to "ask", and therefore fell out of
 * this hard gate into the approval round-trip. Splitting inside quotes was the
 * other half of the mismatch: `git commit -m "a; b"` became two bogus segments.
 */
function splitBash(command: unknown): string[] {
  const out: string[] = []
  collectSegments(String(command ?? ""), out, 0)
  return out
}

/**
 * Core `bash` tool spellings (sidecar coreFiles suite). They carry a free-form
 * `command` exactly like SDK Bash, so command rules authored under the `Bash`
 * key apply to them too.
 */
const CORE_BASH_NAMES = new Set(["bash", "mcp__cognia-tools__bash"])

/** Pull the resolution target out of a tool-call input. */
function extractTarget(toolName: string, input: unknown): string {
  const obj: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (toolName === "Bash" || CORE_BASH_NAMES.has(toolName)) {
    return typeof obj.command === "string" ? obj.command : ""
  }
  if (toolName === "shell_execute_advanced") {
    const head = typeof obj.command === "string" ? obj.command : ""
    const args = Array.isArray(obj.args) ? obj.args.filter((a) => typeof a === "string") : []
    return [head, ...args].join(" ").trim()
  }
  if (toolName === "start_process") {
    const program = typeof obj.program === "string" ? obj.program : ""
    const args = Array.isArray(obj.args) ? obj.args.filter((a) => typeof a === "string") : []
    return [program, ...args].join(" ").trim()
  }
  if (typeof obj.file_path === "string") return obj.file_path
  if (typeof obj.path === "string") return obj.path
  return ""
}

/**
 * Resolve the verdict for a whole tool call. For shell tools the command is
 * split into segments: any explicit `deny` wins; an `allow` is only returned
 * when EVERY segment is explicitly allowed; everything else → "ask" (round
 * trip). Non-shell tools resolve their single target directly.
 */
export function resolveForToolCall(ruleset: unknown, toolName: string, input: unknown): Verdict {
  const canonical = [
    "mcp__cognia-tools__start_process",
    "mcp__cognia-tools__shell_execute_advanced",
  ].includes(toolName)
    ? toolName.slice("mcp__cognia-tools__".length)
    : toolName
  const target = extractTarget(canonical, input)
  const isShell =
    toolName === "Bash" ||
    CORE_BASH_NAMES.has(toolName) ||
    canonical === "shell_execute_advanced" ||
    canonical === "start_process"

  if (!isShell) {
    return resolveToolVerdict(ruleset, toolName, target) ?? "ask"
  }

  const segments = splitBash(target)
  const targets = segments.length ? segments : [target]
  let allAllow = true
  let worst: Verdict = "allow"
  for (const t of targets) {
    // Core bash also honours rules keyed under its literal tool name; when
    // both a `Bash` rule and a tool-name rule match, the more severe wins.
    let v = resolveToolVerdict(ruleset, "Bash", t)
    if (toolName !== "Bash") {
      const own = resolveToolVerdict(ruleset, toolName, t)
      if (own !== null && (v === null || VERDICT_RANK[own] > VERDICT_RANK[v])) v = own
    }
    if (v === "deny") return "deny"
    // Deny probe against the canonical spelling — see `canonicalizeCommand`.
    // Kept out of the `allAllow` bookkeeping on purpose: a canonical form that
    // matches nothing must not downgrade an otherwise explicit allow.
    const canonical = canonicalizeCommand(t)
    if (canonical && canonical !== t) {
      if (resolveToolVerdict(ruleset, "Bash", canonical) === "deny") return "deny"
      if (toolName !== "Bash" && resolveToolVerdict(ruleset, toolName, canonical) === "deny") {
        return "deny"
      }
    }
    if (v === null || v === "ask") {
      allAllow = false
      if (VERDICT_RANK[worst] < VERDICT_RANK["ask"]) worst = "ask"
    }
  }
  return allAllow ? "allow" : worst
}
