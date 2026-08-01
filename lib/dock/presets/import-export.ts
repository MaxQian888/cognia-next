/**
 * The preset file format.
 *
 * Exporting produces plain JSON with a kind marker, so a file dropped on the
 * app can be recognised before it is parsed as anything. Importing runs the
 * whole payload through `validateDockPreset` — there is no path from a file to
 * the store that skips validation.
 */

import {
  DOCK_PRESET_FILE_KIND,
  DOCK_PRESET_SCHEMA_VERSION,
  type DockPreset,
  type DockPresetFile,
} from "@/types/dock/preset"
import {
  validateDockPreset,
  type DockPresetRejection,
  type ValidateDockPresetOptions,
} from "./validate"

/** Bytes an import will read. A preset is a few KB; anything larger is not one. */
export const DOCK_PRESET_MAX_FILE_BYTES = 256 * 1024

export function serializeDockPreset(preset: DockPreset): string {
  const file: DockPresetFile = {
    kind: DOCK_PRESET_FILE_KIND,
    schemaVersion: DOCK_PRESET_SCHEMA_VERSION,
    // `builtin` never travels: a preset shipped with one build is not shipped
    // with the machine importing it.
    preset: { ...preset, builtin: undefined },
  }
  return JSON.stringify(file, null, 2)
}

/** A filename that is safe on every platform the app runs on. */
export function dockPresetFileName(preset: DockPreset): string {
  const slug =
    preset.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "preset"
  return `cognia-dock-${preset.host}-${slug}.json`
}

export type DockPresetImportRejection =
  DockPresetRejection | "not-json" | "wrong-kind" | "too-large"

export type DockPresetImport =
  | { ok: true; preset: DockPreset }
  | { ok: false; rejection: DockPresetImportRejection; panelId?: string }

export function parseDockPresetFile(
  text: string,
  options: ValidateDockPresetOptions
): DockPresetImport {
  if (text.length > DOCK_PRESET_MAX_FILE_BYTES) {
    return { ok: false, rejection: "too-large" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, rejection: "not-json" }
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== DOCK_PRESET_FILE_KIND
  ) {
    return { ok: false, rejection: "wrong-kind" }
  }

  const result = validateDockPreset((parsed as { preset?: unknown }).preset, options)
  return result.ok
    ? { ok: true, preset: result.preset }
    : { ok: false, rejection: result.rejection, panelId: result.panelId }
}
