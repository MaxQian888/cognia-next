// Sidecar-side glob permission resolver — the JS mirror of
// `lib/claude/permissions/ruleset.ts`, consulted by `canUseTool`
// (`anthropic.mjs`) to short-circuit the `permission_request` round-trip when
// the renderer pre-resolved an *explicit* allow/deny rule for a tool call.
//
// Deliberately narrow: it only acts on EXPLICIT matches in the serialized
// ruleset (no baked-in `*: allow` default — that would silently bypass every
// approval). A non-match resolves to "ask", which means "fall through to the
// normal round-trip". The rich, compound-command-aware classifier + model
// judge live renderer-side (the Auto-mode Layer B in use-claude-chat); this
// fast-path only honors the static rules the user/character/plugin configured.

const VERDICTS = new Set(["allow", "ask", "deny"])
const VERDICT_RANK = { allow: 0, ask: 1, deny: 2 }

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob) {
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

const regexCache = new Map()
function cachedRegex(glob) {
  let r = regexCache.get(glob)
  if (!r) {
    r = globToRegExp(glob)
    regexCache.set(glob, r)
  }
  return r
}

function basename(p) {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

export function matchGlob(glob, target) {
  const re = cachedRegex(glob)
  if (re.test(target)) return true
  if (!glob.includes("/") && !glob.includes("\\")) return re.test(basename(target))
  return false
}

function specificity(glob) {
  let n = 0
  for (const c of glob) if (c !== "*" && c !== "?") n++
  return n
}

/**
 * Resolve a single (tool, target) against the ruleset. Returns the matched
 * verdict ("allow"|"ask"|"deny"), or `null` when no rule matched.
 */
export function resolveToolVerdict(ruleset, toolName, target) {
  if (!ruleset || typeof ruleset !== "object") return null
  let best = null // { toolScore, globScore, verdict }
  for (const toolKey of [toolName, "*"]) {
    const entry = ruleset[toolKey]
    if (entry == null) continue
    const toolScore = toolKey === toolName ? 2 : 1
    if (typeof entry === "string") {
      if (VERDICTS.has(entry)) best = better(best, { toolScore, globScore: 0, verdict: entry })
    } else if (typeof entry === "object") {
      for (const [glob, verdict] of Object.entries(entry)) {
        if (!VERDICTS.has(verdict)) continue
        if (matchGlob(glob, target ?? "")) {
          best = better(best, { toolScore, globScore: specificity(glob), verdict })
        }
      }
    }
  }
  return best ? best.verdict : null
}

function better(a, b) {
  if (!a) return b
  if (b.toolScore !== a.toolScore) return b.toolScore > a.toolScore ? b : a
  return b.globScore >= a.globScore ? b : a
}

/** Naive top-level split for Bash targets (operators, quotes ignored). */
function splitBash(command) {
  return String(command)
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Pull the resolution target out of a tool-call input. */
function extractTarget(toolName, input) {
  const obj = input && typeof input === "object" ? input : {}
  if (toolName === "Bash") return typeof obj.command === "string" ? obj.command : ""
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
export function resolveForToolCall(ruleset, toolName, input) {
  const target = extractTarget(toolName, input)
  const isShell =
    toolName === "Bash" || toolName === "shell_execute_advanced" || toolName === "start_process"

  if (!isShell) {
    return resolveToolVerdict(ruleset, toolName, target) ?? "ask"
  }

  const segments = splitBash(target)
  const targets = segments.length ? segments : [target]
  let allAllow = true
  let worst = "allow"
  for (const t of targets) {
    const v = resolveToolVerdict(ruleset, "Bash", t)
    if (v === "deny") return "deny"
    if (v === null || v === "ask") {
      allAllow = false
      if (VERDICT_RANK[worst] < VERDICT_RANK["ask"]) worst = "ask"
    }
  }
  return allAllow ? "allow" : worst
}
