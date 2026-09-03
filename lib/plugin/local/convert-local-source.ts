/**
 * Inspect a picked directory the way the GitHub install path inspects a repo.
 *
 * `convertPluginBundle` has been able to turn a Claude Code, Codex or Gemini
 * bundle into a Cognia manifest for a long time, and exactly one of the five
 * install paths called it. Load unpacked read `<dir>/plugin.json` and nothing
 * else, so picking a foreign bundle produced a raw error string and no hint
 * that the same directory installs cleanly from GitHub.
 *
 * Returns the blocking report instead of throwing when a bundle cannot be
 * converted, so the dialog can say WHICH capability blocked it. A thrown
 * `UnsupportedPluginConversionError` carries that report and losing it would
 * put us back where we started.
 */

import {
  UnsupportedPluginConversionError,
  convertPluginBundle,
  detectPluginEcosystem,
  type PluginConversionReport,
  type PluginEcosystem,
} from "@/lib/plugin/convert/ecosystem"
import { generatedFilesFrom } from "@/lib/plugin/convert/source-snapshot"
import type { PluginManifest } from "@/types/plugin"

import { collectLocalPluginSource, type LocalSourceFs } from "./local-source-snapshot"

export interface LocalPluginInspection {
  /** The ecosystem detected from the bundle's marker file. */
  sourceFormat: PluginEcosystem
  report: PluginConversionReport
  /** Present only when the bundle can actually be installed. */
  manifest?: PluginManifest
  /** Files the installer must overlay after copying the source tree. */
  generatedFiles: Record<string, string>
  /** False when `report.blocking` explains why this cannot be installed. */
  convertible: boolean
  /** True when no conversion is involved and the old path applies unchanged. */
  native: boolean
}

/**
 * Read and convert `sourceDir`.
 *
 * Throws only for a source that cannot be read or is not a plugin at all. A
 * bundle that IS a plugin but cannot be converted comes back with
 * `convertible: false` and a populated report.
 */
export async function inspectLocalPluginSource(
  sourceDir: string,
  fs?: LocalSourceFs
): Promise<LocalPluginInspection> {
  const snapshot = await collectLocalPluginSource(sourceDir, fs)
  if (snapshot.files.size === 0) {
    throw new Error(`no readable files in ${sourceDir}`)
  }

  const sourceFormat = detectPluginEcosystem(snapshot.files)
  const native = sourceFormat === "cognia"

  try {
    const converted = convertPluginBundle(snapshot.files, "cognia", {
      binaryPaths: snapshot.binaryPaths,
    })
    return {
      sourceFormat,
      report: converted.report,
      manifest: converted.manifest,
      generatedFiles: generatedFilesFrom(snapshot.files, converted.files),
      convertible: true,
      native,
    }
  } catch (error) {
    if (error instanceof UnsupportedPluginConversionError) {
      return {
        sourceFormat,
        report: error.report,
        generatedFiles: {},
        convertible: false,
        native,
      }
    }
    if (native && error instanceof SyntaxError) {
      // Same message the GitHub path gives, for the same cause.
      throw new Error("plugin.json is not valid JSON")
    }
    throw error
  }
}
