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
 * the sidecar `canUseTool` callback (`sidecar/dispatch/anthropic.mjs`):
 *   - "allow" → run without prompting,
 *   - "ask"   → emit the existing `permission_request` round-trip,
 *   - "deny"  → reject the tool call.
 *
 * No new dependency: the glob matcher is a small internal implementation
 * (the patterns we need are file/tool globs, not full extglob).
 */

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

export interface ResolveOptions {
  /** Workspace root; targets resolving outside it escalate allow→ask. */
  cwd?: string
}

/**
 * Baked-in safety defaults (lowest precedence). Secrets are gated behind a
 * prompt; everything else defaults open so the coarse allow/deny layer
 * keeps its current behavior unless a higher-precedence ruleset narrows it.
 */
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

/** Escape a string for safe inclusion in a RegExp literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/**
 * Convert a glob to an anchored RegExp. `**` matches across path
 * separators, `*` matches within a segment, `?` matches a single non-sep
 * char. Implemented as a single left-to-right scan so `**` is handled
 * before the `*` rule.
 */
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

/**
 * Match a glob against a target. A glob with no path separator also
 * matches the target's basename (so `*.env` matches `/proj/.env`).
 */
export function matchGlob(glob: string, target: string): boolean {
  const re = cachedRegex(glob)
  if (re.test(target)) return true
  if (!glob.includes("/") && !glob.includes("\\")) return re.test(basename(target))
  return false
}

/** Specificity score: count of literal (non-wildcard) characters. */
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

/**
 * Resolve the verdict for a tool call. Later rulesets override earlier
 * ones; within a layer, a more specific (tool, glob) match wins.
 *
 * @param tool    Tool name, e.g. `Edit`, `Bash`, `task`.
 * @param target  The call's target — file path, command, subagent name.
 * @param rulesets Ordered low→high precedence (the DEFAULT_RULESET is
 *                 prepended automatically as the lowest layer).
 */
export function resolvePermission(
  tool: string,
  target: string | undefined,
  rulesets: Ruleset[],
  opts: ResolveOptions = {}
): PermissionVerdict {
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

  if (!best) return "allow"

  // Safety: an allow that came only from the baked-in defaults is
  // escalated to a prompt when the target escapes the workspace. An
  // explicit user/character/agent rule (layer > 0) is respected as-is.
  const winner: Candidate = best
  if (winner.verdict === "allow" && winner.layer === 0 && isExternalPath(target, opts.cwd)) {
    return "ask"
  }
  return winner.verdict
}

/**
 * Deep-merge rulesets (later overrides earlier), flattening per-tool glob
 * maps. Useful for serializing a single resolved ruleset into SendOptions.
 */
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
