// Secret scrubbing for everything this harness prints or writes to disk.
//
// The runner holds five platforms' worth of live credentials and talks to real
// conversations. Two things must never reach stdout or `test-results/`:
// credentials, and the bodies of real messages that happen to be in the target
// chat. Platform SDK errors are the main leak vector — several of them quote
// the failing request URL back at you, and a Telegram bot token lives in the
// path segment of every one of its calls.
//
// Two layers, because either alone is unsafe:
//   1. Registered values — authoritative. Anything `config.mjs` reads out of
//      the environment as a secret is registered here and replaced verbatim.
//   2. Shape patterns — the net for what we never saw. A credential rotated
//      mid-run, a token embedded in an error from a library, a secret in a
//      field we did not model.
//
// Registered values are matched before patterns so a registered secret is
// always labelled with its own name rather than a generic shape.

/** Token shapes worth catching even when we never registered the value. */
const PATTERNS = [
  // `Authorization: Bearer …` / `DPoP …` and bare bearer strings.
  [/\b(Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 «redacted»"],
  // Telegram bot token — `<botId>:<35 chars>`. No leading \b: the token sits in
  // the URL path directly after `bot`, where letter→digit is not a boundary.
  [/(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "«telegram-token»"],
  // Slack tokens: xoxb / xoxp / xoxa / xoxs / xoxe / xapp.
  [/\bxox[abeprs]-[A-Za-z0-9-]{8,}/gi, "«slack-token»"],
  [/\bxapp-[A-Za-z0-9-]{8,}/gi, "«slack-app-token»"],
  // Matrix access tokens.
  [/\bsyt_[A-Za-z0-9_-]{8,}/g, "«matrix-token»"],
  // Lark app secret / tenant access token.
  [/\b[ut]-[A-Za-z0-9_]{20,}\b/g, "«lark-token»"],
  // Discord bot tokens (three dot-joined base64url runs).
  [/\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, "«discord-token»"],
]

/** Longest-first, so a secret that contains another secret redacts as one unit. */
function byLengthDesc(a, b) {
  return b.value.length - a.value.length
}

export function createRedactor() {
  /** @type {Array<{ value: string, label: string }>} */
  const registered = []

  /**
   * The scrubber, as a closure rather than a method reached through `this`.
   *
   * `redact` hands this to `walk`, and a redactor pulled apart at the call site
   * (`const { redact } = createRedactor()`) would otherwise throw on an
   * undefined `this` — in the one function whose whole job is to run before
   * anything is printed. Every other member here is already `this`-free.
   */
  const redactString = (input) => {
    if (typeof input !== "string" || input === "") return input
    let out = input
    for (const { value, label } of registered) out = out.split(value).join(`«${label}»`)
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
    return out
  }

  return {
    /**
     * Mark `value` as a secret. Short values are ignored: registering a 3-char
     * string would rewrite unrelated substrings of every message and make the
     * output unreadable without protecting anything real.
     */
    register(value, label = "secret") {
      if (typeof value !== "string" || value.length < 8) return
      if (registered.some((entry) => entry.value === value)) return
      registered.push({ value, label })
      registered.sort(byLengthDesc)
    },

    /** Registered secrets, for assertions. Values are never exposed. */
    get labels() {
      return registered.map((entry) => entry.label)
    },

    /** Scrub a string. */
    redactString,

    /**
     * Scrub a whole value: strings in place, arrays and plain objects walked.
     * Non-plain values (Error, Date, Buffer) are stringified first — an Error
     * carrying a credential in its message is the exact case this exists for.
     */
    redact(input) {
      return walk(input, redactString, new WeakSet())
    },
  }
}

/**
 * `path` holds the containers currently being descended into, so a genuine
 * cycle is caught while the same object appearing twice side by side is still
 * walked twice. A back-reference — trivially producible by a platform SDK
 * response or a hand-built diagnostic payload — would otherwise recurse until
 * the stack blows, and it would do it *before* anything reached the output.
 * Failing to redact is the one failure this module cannot have, so a cycle is
 * named and dropped rather than followed.
 */
function walk(input, scrub, path) {
  if (typeof input === "string") return scrub(input)
  if (input === null || input === undefined) return input
  if (typeof input === "number" || typeof input === "boolean") return input
  if (input instanceof Error) return scrub(`${input.name}: ${input.message}`)
  if (Array.isArray(input)) {
    if (path.has(input)) return "«circular»"
    path.add(input)
    const out = input.map((item) => walk(item, scrub, path))
    path.delete(input)
    return out
  }
  if (typeof input === "object") {
    if (Object.getPrototypeOf(input) !== Object.prototype) return scrub(String(input))
    if (path.has(input)) return "«circular»"
    path.add(input)
    const out = {}
    for (const [key, value] of Object.entries(input)) out[key] = walk(value, scrub, path)
    path.delete(input)
    return out
  }
  return scrub(String(input))
}
