import type { PluginFilesAPI } from "@cognia/plugin-sdk"

/** What `ctx.files.save` reports back: saved or cancelled, and where it went. */
export type FileSaveOutcome = Awaited<ReturnType<PluginFilesAPI["save"]>>

/** Characters no filesystem accepts in a name — path separators included. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g
const MAX_BASENAME_LENGTH = 120

/** Control characters (U+0000–U+001F, U+007F) are never valid in a filename. */
function stripControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? "-" : char
  }).join("")
}

/**
 * Turn a model- or title-supplied name into a bare filename `ctx.files.save`
 * accepts: separators and reserved characters become `-` (the host refuses a
 * name containing a path), the extension is forced to `extension` without
 * doubling it, and an empty result falls back to `fallback`.
 */
export function normalizeExportName(
  value: string | undefined,
  extension: string,
  fallback: string
): string {
  const ext = extension.replace(/^\./, "").toLowerCase()
  const withoutExt = (value ?? "").trim().replace(new RegExp(`\\.${ext}$`, "i"), "")
  const base = stripControlCharacters(withoutExt)
    .replace(UNSAFE_FILENAME_CHARS, "-")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, MAX_BASENAME_LENGTH)
    .trim()
  return `${base || fallback}.${ext}`
}

/** Model-facing result of an export: whether a file was written and where. */
export interface ExportSaveSummary {
  ok: boolean
  saved: boolean
  cancelled?: true
  filename: string
  platform?: FileSaveOutcome["platform"]
  location?: string
  /** One sentence the assistant can relay to the user as-is. */
  message: string
}

/**
 * Word the save outcome so the assistant tells the user where the file went —
 * a phone has no save dialog, the file lands in Documents/cognia/exports — or
 * that nothing was written because they cancelled.
 */
export function summarizeSave(outcome: FileSaveOutcome, filename: string): ExportSaveSummary {
  if (!outcome.saved) {
    return {
      ok: false,
      saved: false,
      cancelled: true,
      filename,
      message: `The save was cancelled, so ${filename} was not written. Tell the user nothing was saved.`,
    }
  }
  const base = {
    ok: true,
    saved: true,
    filename,
    ...(outcome.platform ? { platform: outcome.platform } : {}),
    ...(outcome.location ? { location: outcome.location } : {}),
  }
  if (outcome.platform === "mobile") {
    return {
      ...base,
      message: `Saved ${filename} on this device in Documents/cognia/exports${
        outcome.location ? ` (${outcome.location})` : ""
      }. Tell the user they can open it from the Files app.`,
    }
  }
  if (outcome.platform === "web") {
    return {
      ...base,
      message: `The browser downloaded ${filename} to the user's Downloads folder.`,
    }
  }
  if (outcome.platform === "desktop") {
    return {
      ...base,
      message: `Saved ${filename} to the location the user chose in the save dialog.`,
    }
  }
  return { ...base, message: `Saved ${filename}.` }
}
