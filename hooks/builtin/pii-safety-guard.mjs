// Built-in hook: deny a turn / tool call that carries obvious PII.
//
// Fires on UserPromptSubmit (scans `prompt`) and PreToolUse (scans the
// stringified `tool_input`). Defense-in-depth only: the authoritative redaction
// gate is the in-app `packages/redact/src/index.ts` path; this catches plain
// credentials and identifiers that slip into an agent turn outside that gate.
//
// Blocks by exiting 2 with the matched category on stderr (the shared Rust + CLI
// blocking contract). A clean turn exits 0. Designed to be conservative — only
// high-precision patterns — so it rarely false-positives on normal prose.
import { readFileSync } from "node:fs"

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}

const haystack = [
  typeof input.prompt === "string" ? input.prompt : "",
  input.tool_input != null ? safeStringify(input.tool_input) : "",
]
  .filter(Boolean)
  .join("\n")

if (!haystack) process.exit(0)

function safeStringify(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return ""
  }
}

/** High-precision PII patterns. Order = reported priority. */
const PATTERNS = [
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  // Generic high-entropy secret assignments (api_key=..., token: "...")
  [
    /\b(?:api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i,
    "API key / secret",
  ],
  // Private key block
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "private key"],
  // Credit-card-like (13–16 digits, optional separators) — Luhn-checked below
  [/\b(?:\d[ -]?){13,16}\b/, "credit card number"],
  // US SSN
  [/\b\d{3}-\d{2}-\d{4}\b/, "US SSN"],
]

function luhnValid(digits) {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

for (const [pattern, label] of PATTERNS) {
  const m = haystack.match(pattern)
  if (!m) continue
  if (label === "credit card number") {
    const digits = m[0].replace(/\D/g, "")
    if (digits.length < 13 || !luhnValid(digits)) continue
  }
  process.stderr.write(
    `Blocked: turn appears to contain ${label}. Remove the sensitive value ` +
      `(or disable the pii-safety-guard built-in hook if this is a false positive).\n`
  )
  process.exit(2)
}
process.exit(0)
