/**
 * Decode raw shell output bytes into text, auto-handling the legacy console
 * encoding on Windows.
 *
 * The problem: on a Chinese (or Japanese / Korean / …) Windows, console programs
 * print to a piped stdout in the system **OEM code page** (e.g. cp936 / GBK), not
 * UTF-8. Decoding those bytes as UTF-8 — Node's `Buffer.toString()` default —
 * mojibakes every non-ASCII character. But other programs (Node itself, many
 * UTF-8-aware CLIs) *do* emit UTF-8, so a fixed GBK decoder would corrupt those
 * instead. There is no single right answer per platform — only per output.
 *
 * The fix: try strict UTF-8 first; if the bytes aren't valid UTF-8, fall back to
 * the detected OEM code page. ASCII is a subset of both, so pure-ASCII output is
 * unaffected either way; this only changes how non-ASCII bytes are interpreted.
 * On non-Windows the OEM label resolves to UTF-8, so the fallback is a no-op.
 */
import { spawnSync } from "node:child_process"

/** Windows code-page number → WHATWG `TextDecoder` label (Node ships full ICU). */
const CODEPAGE_LABELS: Record<number, string> = {
  65001: "utf-8",
  936: "gbk", // Simplified Chinese (PRC)
  950: "big5", // Traditional Chinese
  932: "shift_jis", // Japanese
  949: "euc-kr", // Korean
  1252: "windows-1252", // Western European
  1251: "windows-1251", // Cyrillic
  1250: "windows-1250", // Central European
  874: "windows-874", // Thai
}

let cachedLabel: string | null = null

/**
 * The `TextDecoder` label for the active Windows console code page (cached). On
 * non-Windows this is always `"utf-8"`. Detected once via `chcp`, which prints
 * `Active code page: NNN` (the prefix is localized, so we parse the trailing
 * number); any failure falls back to UTF-8.
 */
export function consoleDecoderLabel(): string {
  if (cachedLabel !== null) return cachedLabel
  if (process.platform !== "win32") return (cachedLabel = "utf-8")
  try {
    // Read as latin1 so the (possibly non-ASCII, localized) prefix can't throw;
    // we only care about the ASCII digits at the end.
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

/** Reset the cached code page — for tests that exercise the detection branches. */
export function __resetConsoleDecoderCache(): void {
  cachedLabel = null
}

/**
 * Decode a complete output buffer: strict UTF-8 when valid, otherwise the OEM
 * code page. Use at end-of-stream when the full byte sequence is available.
 */
export function decodeConsoleBytes(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder(consoleDecoderLabel(), { fatal: false }).decode(buf)
  }
}
