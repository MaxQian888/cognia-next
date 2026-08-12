// Shared safety helpers for the Cognia built-in tools server.
//
// Three responsibilities:
//   1. Path-traversal guard for any tool that takes a filesystem path under a
//      caller-supplied root.
//   2. Allowlist + blocklist + dangerous-pattern guard for the
//      shell_execute_advanced and start_process tools (mirrored verbatim from
//      `D:\Project\Cognia\lib\ai\tools\shell-tool.ts:60-136`).
//   3. MCP `CallToolResult` formatters so every tool returns the same shape.
//
// Pure: no I/O beyond path canonicalisation.

import path from "node:path"
import fs from "node:fs"
import { parse as parseBash } from "unbash"

// ---- Path traversal -------------------------------------------------------

/**
 * Canonicalise both root and target, then assert that target lives inside
 * root. Mirrors the Tauri side's `fs_read_workspace_file` guard
 * (src-tauri/src/files.rs:240-260). Throws with a clear message on escape.
 *
 * @param {string} rootCwd  Absolute path to the trusted root.
 * @param {string} target   Absolute or relative path to check.
 * @returns {string}        The canonicalised absolute target path.
 */
export function assertPathInside(rootCwd, target) {
  if (typeof rootCwd !== "string" || rootCwd.length === 0) {
    throw new Error("rootCwd must be a non-empty string")
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("target must be a non-empty string")
  }
  const absRoot = path.resolve(rootCwd)
  const absTarget = path.isAbsolute(target) ? target : path.resolve(absRoot, target)
  // Use realpath where possible so symlink escapes are caught. Fall back to
  // the lexically resolved path when the target doesn't exist yet (e.g.
  // before file_write).
  const canonicalRoot = safeRealpath(absRoot) ?? absRoot
  const canonicalTarget = canonicalisePartial(absTarget)
  // Normalise trailing separators so a root of "/a" doesn't accept "/aa".
  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootWithSep)) {
    throw new Error(`path escapes root: ${canonicalTarget} (root: ${canonicalRoot})`)
  }
  return canonicalTarget
}

export function safeRealpath(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * Canonicalise a path that may not exist yet (write targets). Resolves the
 * longest existing ancestor via realpath — so platform symlinks like macOS's
 * `/var` -> `/private/var` are collapsed the same way the root is — then
 * re-appends the not-yet-created trailing segments. Without this, a write
 * target under a symlinked temp dir is compared lexically against a realpath'd
 * root and falsely reported as escaping it.
 *
 * @param {string} absTarget  An absolute path.
 * @returns {string}
 */
export function canonicalisePartial(absTarget) {
  let current = absTarget
  const missing = [] // segments collected deepest-first
  for (;;) {
    const real = safeRealpath(current)
    if (real !== null) {
      return missing.length ? path.join(real, ...missing.reverse()) : real
    }
    const parent = path.dirname(current)
    if (parent === current) break // reached the filesystem root; nothing exists
    missing.push(path.basename(current))
    current = parent
  }
  return absTarget
}

/**
 * Convenience wrapper for tools that don't take a custom root: defends
 * against absolute paths that point at filesystem roots the user clearly
 * didn't intend to expose. Currently a no-op pass-through — the SDK's own
 * `additionalDirectories` mechanism is the primary scope guard. We keep this
 * indirection so a future "user-confined sandbox" mode has a single place
 * to plug in.
 *
 * @param {string} target
 * @returns {string}
 */
export function normaliseAbsolutePath(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("path must be a non-empty string")
  }
  return path.resolve(target)
}

// ---- Shell command validation --------------------------------------------

/**
 * Commands explicitly blocked because they're destructive enough that the
 * user almost never wants them invoked from chat. Lifted verbatim from
 * Cognia's shell-tool.ts:111-124.
 *
 * @type {ReadonlySet<string>}
 */
export const BLOCKED_COMMANDS = new Set([
  // Deletion — use file_delete / directory_delete (with approval) instead.
  "rm",
  "rmdir",
  "del",
  "erase",
  // Disk operations.
  "format",
  "fdisk",
  "mkfs",
  // System control.
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  // User management.
  "passwd",
  "useradd",
  "userdel",
  "usermod",
  // Permission changes.
  "chmod",
  "chown",
  "chgrp",
  // Raw disk write.
  "dd",
  // Swap management.
  "mkswap",
  "swapon",
  "swapoff",
  // Mount operations.
  "mount",
  "umount",
  // Firewall.
  "iptables",
  "firewall-cmd",
  "ufw",
  // Service management.
  "systemctl",
  "service",
  // Cron.
  "crontab",
  // Windows registry.
  "reg",
  "regedit",
])

/**
 * Read-only / development-friendly commands that are explicitly allowed
 * without further checks beyond the dangerous-pattern scan. Lifted from
 * shell-tool.ts:60-106 with the destructive items pruned (rm, del, etc are
 * in BLOCKED_COMMANDS even if they would otherwise pass).
 *
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_COMMANDS = new Set([
  // File browsing.
  "ls",
  "dir",
  "find",
  "tree",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "where",
  "whereis",
  "type",
  // Text processing.
  "grep",
  "rg",
  "ag",
  "awk",
  "sed",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "comm",
  "strings",
  "hexdump",
  "xxd",
  // Version control.
  "git",
  "svn",
  "gh",
  "hg",
  // Package managers & runners.
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "cargo",
  "go",
  "composer",
  "gem",
  "dotnet",
  "mvn",
  "gradle",
  "deno",
  "proto",
  // Development tools.
  "node",
  "python",
  "python3",
  "ruby",
  "java",
  "javac",
  "rustc",
  "gcc",
  "g++",
  "clang",
  "make",
  "cmake",
  "tsc",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "playwright",
  "swift",
  "swiftc",
  "kotlin",
  "kotlinc",
  // Mobile & cross-platform.
  "flutter",
  "dart",
  "expo",
  "react-native",
  // Linters & formatters.
  "ruff",
  "black",
  "mypy",
  "flake8",
  "pylint",
  "isort",
  "clippy",
  "rustfmt",
  "gofmt",
  "golint",
  "golangci-lint",
  "biome",
  "oxlint",
  "dprint",
  // System info.
  "uname",
  "hostname",
  "whoami",
  "id",
  "env",
  "printenv",
  "date",
  "uptime",
  "free",
  "top",
  "htop",
  "ps",
  "echo",
  // Network read-only.
  "ping",
  "curl",
  "wget",
  "dig",
  "nslookup",
  "traceroute",
  "tracert",
  "netstat",
  "ss",
  "ifconfig",
  "ip",
  // Archive read.
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "7z",
  // Windows specific.
  "cmd",
  "powershell",
  "pwsh",
  "systeminfo",
  "tasklist",
  "ipconfig",
  // Containers.
  "docker",
  "docker-compose",
  "podman",
  // DevOps & cloud.
  "terraform",
  "kubectl",
  "helm",
  "ansible",
  "vagrant",
  "aws",
  "az",
  "gcloud",
  "heroku",
  "vercel",
  "netlify",
  // Media.
  "ffmpeg",
  "ffprobe",
  "magick",
  "convert",
  "identify",
  // Database clients.
  "psql",
  "mysql",
  "sqlite3",
  "mongosh",
  "redis-cli",
])

/**
 * Patterns whose presence in the args is an immediate reject — they indicate
 * shell injection or chaining toward a destructive command. Mirrors
 * shell-tool.ts:129-136.
 *
 * @type {RegExp[]}
 */
export const DANGEROUS_PATTERNS = [
  /;\s*(rm|rmdir|del|erase|format|shutdown|reboot|halt|poweroff)\b/i,
  /\|\s*(rm|rmdir|del|format|shutdown|reboot)\b/i,
  />\s*\/dev\//i,
  /&&\s*(rm|rmdir|del|format|shutdown|reboot)\b/i,
  /`[^`]*(rm|rmdir|del|format|shutdown|reboot)[^`]*`/i,
  /\$\([^)]*(rm|rmdir|del|format|shutdown|reboot)[^)]*\)/i,
]

const DESTRUCTIVE_SHELL_COMMANDS = new Set([
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
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "<>", "&>", "&>>"])

/**
 * Parse a Bash command and return the first structurally dangerous fragment.
 * Unlike the legacy regex scan this distinguishes real redirects / nested
 * commands from identical text inside a quoted argument. `unbash` is a parser,
 * not a policy engine; the allow/block decisions remain explicit here.
 *
 * @param {string} source
 * @returns {{ fragment: string, kind: "command" | "deviceRedirect" } | null}
 */
export function findDangerousShellFragment(source) {
  if (typeof source !== "string" || source.length === 0) return null

  let script
  try {
    script = parseBash(source)
  } catch {
    // A parser failure must not weaken the existing defence-in-depth rule.
    for (const pattern of DANGEROUS_PATTERNS) {
      const match = source.match(pattern)
      if (match) return { fragment: match[0], kind: "command" }
    }
    return null
  }

  /** @type {{ fragment: string, kind: "command" | "deviceRedirect" } | null} */
  let found = null
  const seen = new WeakSet()

  /** @param {unknown} value */
  const visit = (value) => {
    if (found || value == null || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)

    if (value.type === "Command") {
      const commandName = value.name?.value
      if (typeof commandName === "string" && DESTRUCTIVE_SHELL_COMMANDS.has(commandName)) {
        const nameStart = value.name.pos ?? value.pos ?? 0
        const boundary = source.slice(0, nameStart).match(/(?:&&|\|\||[;|])\s*$/)
        found = {
          fragment: source.slice(
            boundary ? nameStart - boundary[0].length : nameStart,
            value.name.end ?? value.end
          ),
          kind: "command",
        }
        return
      }
    }

    if (WRITE_REDIRECTS.has(value.operator) && value.target) {
      const target = value.target.value
      if (
        typeof target === "string" &&
        target.startsWith("/dev/") &&
        !SAFE_DEVICE_REDIRECT.test(target)
      ) {
        found = {
          fragment: source.slice(value.pos ?? value.target.pos ?? 0, value.end ?? value.target.end),
          kind: "deviceRedirect",
        }
        return
      }
    }

    for (const child of Object.values(value)) visit(child)
    // Word expansion parts are deliberately lazy/non-enumerable in unbash, so
    // read them explicitly to reach $(...), backticks, and nested redirects.
    try {
      if (Array.isArray(value.parts)) visit(value.parts)
      if (Array.isArray(value.indexParts)) visit(value.indexParts)
    } catch {
      // Malformed lazy expansion: the root/partial AST is still useful.
    }
  }

  visit(script)
  if (found) return found

  // Tolerant parsing can return a partial AST. Preserve the old fail-closed
  // scan only for malformed input; valid quoted text never reaches this path.
  if (Array.isArray(script.errors) && script.errors.length > 0) {
    for (const pattern of DANGEROUS_PATTERNS) {
      const match = source.match(pattern)
      if (match) return { fragment: match[0], kind: "command" }
    }
  }
  return null
}

/**
 * Validate that a command name + argv is safe to execute under the
 * shell-advanced policy. Returns `{ safe: true }` on success or
 * `{ safe: false, reason }` with a user-readable explanation otherwise.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {{ safe: true } | { safe: false, reason: string }}
 */
export function validateShellCommand(command, args) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { safe: false, reason: "command must be a non-empty string" }
  }
  // Strip a `.exe` suffix for Windows-friendly comparisons.
  const cmdLower = command.toLowerCase().replace(/\.exe$/i, "")
  if (BLOCKED_COMMANDS.has(cmdLower)) {
    return {
      safe: false,
      reason: `Command '${command}' is blocked. Use the file_delete / directory_delete / process tools (with approval) instead.`,
    }
  }
  if (!ALLOWED_COMMANDS.has(cmdLower)) {
    return {
      safe: false,
      reason: `Command '${command}' is not in the allowed command list. Allowed examples: git, npm, node, python, grep, ls, cat, curl, docker, kubectl.`,
    }
  }
  const argv = Array.isArray(args) ? args : []
  // Reject arg arrays that contain anything but strings — anything else is
  // either a serialisation bug or a shell-injection attempt via object form.
  for (const a of argv) {
    if (typeof a !== "string") {
      return { safe: false, reason: "every argument must be a string" }
    }
  }
  const joined = argv.join(" ")
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(joined)) {
      return {
        safe: false,
        reason: `Dangerous argument pattern detected. Shell injection or chaining with destructive commands is not allowed.`,
      }
    }
  }
  return { safe: true }
}

// ---- MCP CallToolResult helpers ------------------------------------------

/**
 * Build an MCP `CallToolResult` carrying a single text content block.
 * Setting `isError` lets the SDK surface tool failures distinctly from a
 * happy-path text payload.
 *
 * @param {unknown} payload  Stringified or JSON-friendly value.
 * @param {{ isError?: boolean }} [opts]
 */
export function toolText(payload, opts = {}) {
  // Compact (not pretty-printed) JSON: the model parses either form identically,
  // but dropping the 2-space indentation + newlines on every object result trims
  // real tokens across the many object-returning tools (search, hash, stat, …).
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return {
    content: [{ type: "text", text }],
    ...(opts.isError ? { isError: true } : {}),
  }
}

/**
 * Convenience constructor for an error result. Accepts either a string
 * message or an Error; in the Error case we strip the stack trace so we
 * don't leak sidecar internals to the agent.
 *
 * @param {unknown} err
 * @param {string} [contextLabel]  Optional prefix for clarity in chat.
 */
export function toolError(err, contextLabel) {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err)
  const text = contextLabel ? `${contextLabel}: ${message}` : message
  return toolText(text, { isError: true })
}

/**
 * Build an MCP `CallToolResult` carrying a single image content block. The
 * claude-agent-sdk relays this to Claude as a tool_result image; the ai-sdk
 * bridge maps it to a multimodal tool-result part via `toModelOutput`.
 *
 * @param {string} data      Base64-encoded image bytes.
 * @param {string} mimeType  e.g. "image/png".
 * @param {string} [caption] Optional leading text block (path / note).
 */
export function toolImage(data, mimeType, caption) {
  const content = []
  if (caption) content.push({ type: "text", text: caption })
  content.push({ type: "image", data, mimeType })
  return { content }
}
