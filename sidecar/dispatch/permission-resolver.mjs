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

/** Index of the `)` matching the `(` at `openIdx`, or -1. Quote-aware. */
function matchParen(text, openIdx) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
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
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split a command into top-level statements, respecting quotes + paren depth. */
function splitTopLevel(command) {
  const out = []
  let cur = ""
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let depth = 0
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ""
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (inSingle) {
      cur += c
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      cur += c
      if (c === '"') inDouble = false
      continue
    }
    if (inBacktick) {
      cur += c
      if (c === "`") inBacktick = false
      continue
    }
    if (c === "'") {
      inSingle = true
      cur += c
      continue
    }
    if (c === '"') {
      inDouble = true
      cur += c
      continue
    }
    if (c === "`") {
      inBacktick = true
      cur += c
      continue
    }
    if (c === "(") {
      depth++
      cur += c
      continue
    }
    if (c === ")") {
      if (depth > 0) depth--
      cur += c
      continue
    }
    if (depth > 0) {
      cur += c
      continue
    }
    if (c === "&" && next === "&") {
      flush()
      i++
      continue
    }
    if (c === "|" && next === "|") {
      flush()
      i++
      continue
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      flush()
      continue
    }
    cur += c
  }
  flush()
  return out
}

/**
 * Pull `$(...)`, backtick, and `(...)` spans out of `text`. Returns their inner
 * command strings (for recursive processing) plus a `stripped` copy with each
 * span replaced by a space.
 */
function extractSubstitutions(text) {
  const inner = []
  let stripped = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inSingle) {
      stripped += c
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      stripped += c
      if (c === '"') inDouble = false
      continue
    }
    if (c === "'") {
      inSingle = true
      stripped += c
      continue
    }
    if (c === '"') {
      inDouble = true
      stripped += c
      continue
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1)
      if (end === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 1, end))
      i = end
      stripped += " "
      continue
    }
    if (c === "$" && text[i + 1] === "(") {
      const close = matchParen(text, i + 1)
      if (close === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 2, close))
      i = close
      stripped += " "
      continue
    }
    if (c === "(") {
      const close = matchParen(text, i)
      if (close === -1) {
        stripped += c
        continue
      }
      inner.push(text.slice(i + 1, close))
      i = close
      stripped += " "
      continue
    }
    stripped += c
  }
  return { inner, stripped }
}

const MAX_SPLIT_DEPTH = 20

function collectSegments(command, out, depth) {
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
function splitBash(command) {
  const out = []
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
function extractTarget(toolName, input) {
  const obj = input && typeof input === "object" ? input : {}
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
export function resolveForToolCall(ruleset, toolName, input) {
  const target = extractTarget(toolName, input)
  const isShell =
    toolName === "Bash" ||
    CORE_BASH_NAMES.has(toolName) ||
    toolName === "shell_execute_advanced" ||
    toolName === "start_process"

  if (!isShell) {
    return resolveToolVerdict(ruleset, toolName, target) ?? "ask"
  }

  const segments = splitBash(target)
  const targets = segments.length ? segments : [target]
  let allAllow = true
  let worst = "allow"
  for (const t of targets) {
    // Core bash also honours rules keyed under its literal tool name; when
    // both a `Bash` rule and a tool-name rule match, the more severe wins.
    let v = resolveToolVerdict(ruleset, "Bash", t)
    if (CORE_BASH_NAMES.has(toolName)) {
      const own = resolveToolVerdict(ruleset, toolName, t)
      if (own !== null && (v === null || VERDICT_RANK[own] > VERDICT_RANK[v])) v = own
    }
    if (v === "deny") return "deny"
    if (v === null || v === "ask") {
      allAllow = false
      if (VERDICT_RANK[worst] < VERDICT_RANK["ask"]) worst = "ask"
    }
  }
  return allAllow ? "allow" : worst
}
