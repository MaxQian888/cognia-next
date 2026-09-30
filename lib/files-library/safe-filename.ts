/**
 * A name a filesystem accepts, for files Cognia names itself (downloads from
 * Files, generated videos). Only what a filesystem refuses is stripped, so a
 * non-ASCII title stays readable. Bidi controls, which can make a name read
 * differently from what it is, and zero-width spaces are dropped; the joiners
 * emoji and some scripts need are kept. A stem Windows reserves for a device
 * gets a `_` prefix.
 */

/** Bidi embeddings, overrides, isolates and marks; zero-width space; BOM. */
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** Device names Windows refuses as a file stem, with or without an extension. */
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i

export function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(INVISIBLE, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
  if (!cleaned) return fallback
  return WINDOWS_RESERVED_STEM.test(cleaned) ? `_${cleaned}` : cleaned
}
