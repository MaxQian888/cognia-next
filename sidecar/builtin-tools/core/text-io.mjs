// BOM / EOL preserving text IO + per-file write serialization for the core
// write/edit tools.
//
// Matching (fuzzy-replace) always operates on LF-normalized text; this module
// is the boundary that detects the file's original encoding traits on read
// and restores them on write, so an edit never silently rewrites a CRLF file
// to LF or strips a BOM.

import fsp from "node:fs/promises"

const BOM = String.fromCharCode(0xfeff)

/**
 * @param {string} raw
 * @returns {{ content: string, bom: boolean, eol: "\n" | "\r\n" }}
 *   `content` is LF-normalized with the BOM stripped.
 */
export function decodeText(raw) {
  const bom = raw.startsWith(BOM)
  const body = bom ? raw.slice(1) : raw
  const crlf = (body.match(/\r\n/g) ?? []).length
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length
  const eol = crlf > lf ? "\r\n" : "\n"
  return { content: body.replace(/\r\n/g, "\n"), bom, eol }
}

/**
 * @param {string} content LF-normalized text
 * @param {{ bom: boolean, eol: "\n" | "\r\n" }} traits
 * @returns {string}
 */
export function encodeText(content, { bom, eol }) {
  const body = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content
  return bom ? BOM + body : body
}

/**
 * Read a text file preserving its traits.
 * @param {string} absPath
 * @returns {Promise<{ content: string, bom: boolean, eol: "\n" | "\r\n", stat: import("node:fs").Stats }>}
 */
export async function readTextPreserving(absPath) {
  const [raw, stat] = await Promise.all([fsp.readFile(absPath, "utf-8"), fsp.stat(absPath)])
  return { ...decodeText(raw), stat }
}

// ---- Per-file write serialization ------------------------------------------
// write/edit/multi_edit share this promise-chain map so two tool calls
// mutating the same file never interleave their read-modify-write cycles.

/** @type {Map<string, Promise<unknown>>} */
const chains = new Map()

/**
 * Run `fn` exclusively for `key` (a canonical file path). Chained FIFO.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withFileLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Store a failure-swallowed tail so one error never poisons the next
  // waiter; garbage-collect the entry once our tail is still the latest.
  const tail = next
    .catch(() => {})
    .then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
  chains.set(key, tail)
  return next
}
