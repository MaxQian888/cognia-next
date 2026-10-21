/**
 * The factual claims an instruction makes that the repository can contradict
 * (ADR-0238 §7.3): paths it names and package scripts it tells the agent to
 * run. The prompt-audit method's "volatile specifics" row — a rule pointing at
 * a file or a script that no longer exists is a high-confidence stale fact.
 *
 * Only claims a reader would take literally are extracted: inline-code spans
 * and bare tokens shaped like a relative path, never globs, URLs, templates
 * or placeholders. Generated and dependency directories are left out — a path
 * there is not contradicted by being absent from a clean checkout.
 */

export interface ReferenceClaim {
  value: string
  line: number
}

export interface ReferenceClaims {
  paths: ReferenceClaim[]
  scripts: ReferenceClaim[]
}

const CODE_SPAN = /`([^`\n]+)`/g
const BARE_PATH =
  /(?:^|[\s(])((?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\/?)(?=$|[\s),.:;])/g
const SCRIPT_RUNNER =
  /\b(?:pnpm(?: run)?|npm run|yarn(?: run)?|bun run)\s+([A-Za-z0-9][A-Za-z0-9:_.-]*)/g

/** pnpm / yarn subcommands that are not package scripts. */
const RUNNER_BUILTINS = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "config",
  "create",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "fetch",
  "i",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "root",
  "run",
  "self-update",
  "setup",
  "store",
  "unlink",
  "up",
  "update",
  "upgrade",
  "why",
  "workspace",
])

/** Top-level directories that are generated, installed or ignored. */
const GENERATED_PREFIXES = [
  "node_modules/",
  "dist/",
  "out/",
  "build/",
  ".next/",
  "target/",
  "coverage/",
  ".turbo/",
  ".cache/",
]

function looksLikePath(value: string): boolean {
  if (!value.includes("/")) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//")) return false
  if (/[*?{}<>$[\]|]/.test(value) || value.includes("{{")) return false
  if (/\s/.test(value)) return false
  if (value.startsWith("@") && value.split("/").length === 2) return false // a scoped package
  if (value.startsWith("~") || value.startsWith("/")) return false // outside the project: not probed
  const normalized = value.replace(/^\.\//, "")
  if (GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false
  // A path's last segment has an extension or the path ends in a directory slash.
  const last = normalized.replace(/\/$/, "").split("/").pop() ?? ""
  return normalized.endsWith("/") || /\.[A-Za-z0-9]{1,8}$/.test(last)
}

export function extractReferenceClaims(text: string): ReferenceClaims {
  const paths: ReferenceClaim[] = []
  const scripts: ReferenceClaim[] = []
  const seenPaths = new Set<string>()
  const seenScripts = new Set<string>()
  let inFence = false
  text.split("\n").forEach((raw, index) => {
    const line = index + 1
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      // Commands inside fences still name scripts; paths inside are examples.
    }
    for (const match of raw.matchAll(SCRIPT_RUNNER)) {
      // A sentence can end right after the script name: `npm run lint:fix.`
      const name = (match[1] ?? "").replace(/[.:]+$/, "")
      if (!name || RUNNER_BUILTINS.has(name) || seenScripts.has(name)) continue
      seenScripts.add(name)
      scripts.push({ value: name, line })
    }
    if (inFence) return
    const candidates: string[] = []
    for (const match of raw.matchAll(CODE_SPAN)) candidates.push((match[1] ?? "").trim())
    const withoutSpans = raw.replace(CODE_SPAN, " ")
    for (const match of withoutSpans.matchAll(BARE_PATH)) candidates.push(match[1] ?? "")
    for (const candidate of candidates) {
      const value = candidate.replace(/[.,:;]+$/, "")
      if (!looksLikePath(value) || seenPaths.has(value)) continue
      seenPaths.add(value)
      paths.push({ value, line })
    }
  })
  return { paths, scripts }
}
