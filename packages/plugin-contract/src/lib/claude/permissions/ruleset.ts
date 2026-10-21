/**
 * Glob-based permission ruleset (allow / ask / deny) — the fine-grained
 * layer that augments (does not replace) the coarse
 * `allowedTools`/`disallowedTools`/`toolFilter` union assembled in
 * `lib/claude/build-options.ts`.
 *
 * Inspired by OpenCode's `Permission.Ruleset`: a per-tool map of glob →
 * verdict, resolved with deep-merge precedence (defaults → mode →
 * character → per-agent) and safety defaults baked in (`*.env` → ask,
 * paths outside the workspace → ask).
 *
 * The resolved ruleset is serialized into `SendOptions` and consulted by
 * the sidecar's permission ladder (`sidecar/src/policy/permission/ladder.ts`),
 * which both dispatch rails' gates climb:
 *   - "allow" → run without prompting,
 *   - "ask"   → emit the existing `permission_request` round-trip,
 *   - "deny"  → reject the tool call.
 *
 * No new dependency: the glob matcher is a small internal implementation
 * (the patterns we need are file/tool globs, not full extglob).
 */

import { canonicalizeCommand, splitCommandSegments } from "./command-parse"

export type PermissionVerdict = "allow" | "ask" | "deny"

/** Map of glob → verdict for a single tool (or the `*` wildcard tool). */
export type ToolRules = Record<string, PermissionVerdict>

/**
 * A ruleset keyed by tool name (e.g. `Edit`, `Bash`) or `*` for all
 * tools. The value is either a flat verdict for that tool, or a
 * glob→verdict map matched against the call's target (file path, command,
 * subagent name, …).
 */
export type Ruleset = Record<string, PermissionVerdict | ToolRules>

const VERDICT_RANK: Record<PermissionVerdict, number> = { allow: 0, ask: 1, deny: 2 }

export interface ResolveOptions {
  /** Workspace root; targets resolving outside it escalate allow→ask. */
  cwd?: string
}

export const DEFAULT_RULESET: Ruleset = {
  "*": "allow",
  Read: { "**/*.env": "ask", "**/*.env.*": "ask" },
  Edit: { "**/*.env": "ask", "**/*.env.*": "ask" },
  Write: { "**/*.env": "ask", "**/*.env.*": "ask" },
  MultiEdit: { "**/*.env": "ask", "**/*.env.*": "ask" },
}

const VERDICTS: ReadonlySet<string> = new Set(["allow", "ask", "deny"])

function isVerdict(v: unknown): v is PermissionVerdict {
  return typeof v === "string" && VERDICTS.has(v)
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
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

function isExternalPath(target: string | undefined, cwd: string | undefined): boolean {
  if (!target || !cwd) return false
  // Only consider absolute filesystem paths.
  const looksAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(target)
  if (!looksAbsolute) return false
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const t = norm(target)
  const root = norm(cwd)
  return t !== root && !t.startsWith(root + "/")
}

interface Candidate {
  layer: number
  toolScore: number
  globScore: number
  verdict: PermissionVerdict
}

function better(a: Candidate | null, b: Candidate): Candidate {
  if (!a) return b
  if (b.layer !== a.layer) return b.layer > a.layer ? b : a
  if (b.toolScore !== a.toolScore) return b.toolScore > a.toolScore ? b : a
  return b.globScore >= a.globScore ? b : a
}

export function resolvePermission(
  tool: string,
  target: string | undefined,
  rulesets: Ruleset[],
  opts: ResolveOptions = {}
): PermissionVerdict {
  return resolvePermissionDetailed(tool, target, rulesets, opts).verdict
}

export interface ResolvedPermission {
  verdict: PermissionVerdict
  /** 0 = baked-in {@link DEFAULT_RULESET}; >0 = an explicit caller ruleset. */
  layer: number
}

export function resolvePermissionDetailed(
  tool: string,
  target: string | undefined,
  rulesets: Ruleset[],
  opts: ResolveOptions = {}
): ResolvedPermission {
  const layers = [DEFAULT_RULESET, ...rulesets]
  let best: Candidate | null = null

  layers.forEach((rs, layer) => {
    if (!rs) return
    for (const toolKey of [tool, "*"]) {
      const entry = rs[toolKey]
      if (entry == null) continue
      const toolScore = toolKey === tool ? 2 : 1
      if (isVerdict(entry)) {
        best = better(best, { layer, toolScore, globScore: 0, verdict: entry })
      } else {
        for (const [glob, verdict] of Object.entries(entry)) {
          if (!isVerdict(verdict)) continue
          if (matchGlob(glob, target ?? "")) {
            best = better(best, { layer, toolScore, globScore: specificity(glob), verdict })
          }
        }
      }
    }
  })

  if (!best) return { verdict: "allow", layer: 0 }

  // Safety: an allow that came only from the baked-in defaults is
  // escalated to a prompt when the target escapes the workspace. An
  // explicit user/character/agent rule (layer > 0) is respected as-is.
  const winner: Candidate = best
  if (winner.verdict === "allow" && winner.layer === 0 && isExternalPath(target, opts.cwd)) {
    return { verdict: "ask", layer: 0 }
  }
  return { verdict: winner.verdict, layer: winner.layer }
}

export function resolveBashPermission(
  command: string,
  rulesets: Ruleset[],
  opts: ResolveOptions = {}
): { verdict: PermissionVerdict; explicit: boolean } {
  const segments = splitCommandSegments(command)
  if (segments.length === 0) {
    const r = resolvePermissionDetailed("Bash", (command ?? "").trim(), rulesets, opts)
    return { verdict: r.verdict, explicit: r.layer > 0 }
  }
  let worst: PermissionVerdict = "allow"
  let explicit = false
  for (const seg of segments) {
    // Match the full segment first; fall back to the bare head so a rule like
    // `"rm": "ask"` still covers `rm foo.txt`.
    let r = resolvePermissionDetailed("Bash", seg.raw, rulesets, opts)
    if (r.layer === 0 && seg.head !== seg.raw) {
      const byHead = resolvePermissionDetailed("Bash", seg.head, rulesets, opts)
      if (byHead.layer > 0) r = byHead
    }
    // Deny probe against the canonical spelling, so `r\m -rf /` cannot walk
    // past a `Bash(rm *)` deny that `rm -rf /` would hit. DENY ONLY, and
    // deliberately so: canonicalisation mangles an unquoted Windows path, so
    // it may only ever add a refusal, never satisfy an allow.
    if (r.verdict !== "deny") {
      const canonical = canonicalizeCommand(seg.raw)
      if (canonical && canonical !== seg.raw) {
        const byCanonical = resolvePermissionDetailed("Bash", canonical, rulesets, opts)
        if (byCanonical.layer > 0 && byCanonical.verdict === "deny") r = byCanonical
      }
    }
    if (r.layer > 0) explicit = true
    if (VERDICT_RANK[r.verdict] > VERDICT_RANK[worst]) worst = r.verdict
  }
  return { verdict: worst, explicit }
}

export function mergeRulesets(...rulesets: Array<Ruleset | undefined | null>): Ruleset {
  const out: Ruleset = {}
  for (const rs of rulesets) {
    if (!rs) continue
    for (const [tool, entry] of Object.entries(rs)) {
      if (isVerdict(entry)) {
        out[tool] = entry
      } else {
        const prev = out[tool]
        out[tool] = prev && !isVerdict(prev) ? { ...prev, ...entry } : { ...(entry as ToolRules) }
      }
    }
  }
  return out
}
