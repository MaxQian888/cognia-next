// Decode raw shell output bytes into text, auto-handling the legacy console
// encoding on Windows.
//
// On a Chinese / Japanese / Korean / … Windows, console programs print to a
// piped stdout in the system OEM code page (e.g. cp936 / GBK), not UTF-8 —
// `Buffer.toString()` (UTF-8) mojibakes every non-ASCII byte. But Node itself
// and many UTF-8-aware CLIs DO emit UTF-8, so a fixed GBK decoder would corrupt
// those instead. So we decide per output: try strict UTF-8 first, fall back to
// the detected OEM code page. ASCII is a subset of both, so ASCII-only output is
// unaffected. On non-Windows the OEM label is UTF-8, making the fallback a no-op.

import { spawnSync } from "node:child_process"

/** Windows code-page number → WHATWG TextDecoder label (Node ships full ICU). */
const CODEPAGE_LABELS = {
  65001: "utf-8",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
  1251: "windows-1251",
  1250: "windows-1250",
  874: "windows-874",
}

let cachedLabel = null

/** TextDecoder label for the active Windows console code page (cached); always
 * "utf-8" off Windows. Parsed from `chcp` ("Active code page: NNN" — the prefix
 * is localized, so we read the trailing number); any failure → UTF-8. */
export function consoleDecoderLabel() {
  if (cachedLabel !== null) return cachedLabel
  if (process.platform !== "win32") {
    cachedLabel = "utf-8"
    return cachedLabel
  }
  try {
    const res = spawnSync("chcp.com", { encoding: "latin1", windowsHide: true })
    const out = typeof res.stdout === "string" ? res.stdout : ""
    const m = out.match(/(\d+)\s*$/)
    const cp = m ? Number(m[1]) : 65001
    cachedLabel = CODEPAGE_LABELS[cp] ?? "utf-8"
  } catch {
    cachedLabel = "utf-8"
  }
  return cachedLabel
}

/** Reset the cached code page — for tests exercising the detection branches. */
export function __resetConsoleDecoderCache() {
  cachedLabel = null
}

/** Decode a complete buffer: strict UTF-8 when valid, else the OEM code page. */
export function decodeConsoleBytes(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder(consoleDecoderLabel(), { fatal: false }).decode(buf)
  }
}

/**
 * Pick a streaming TextDecoder for a run by sniffing its first chunk: UTF-8 when
 * the chunk is valid UTF-8 (tolerating a trailing incomplete multibyte via
 * `stream`), otherwise the OEM code page. The returned decoder must be used with
 * `decode(chunk, { stream: true })` for the rest of the stream and flushed with a
 * final `decode()` — so multibyte sequences split across chunks decode correctly.
 */
export function pickStreamDecoder(firstChunk) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(firstChunk, { stream: true })
    return new TextDecoder("utf-8")
  } catch {
    return new TextDecoder(consoleDecoderLabel())
  }
}
