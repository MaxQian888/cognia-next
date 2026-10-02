/**
 * Managed IDE Dev Mode schema diagnostics for a plugin folder.
 *
 * The same two checks activation runs, reported instead of thrown, so an
 * author sees every problem in `manifest.ide` while editing rather than the
 * first one when the plugin fails to load: the locked JSON Schema
 * (`validateIdeManifestSchema`), then normalization (namespacing, provider
 * catalog, executables, protocols), which stops at its first refusal.
 */

import type { PluginManifest } from "@/types/plugin"

import { IdeManifestError, normalizeIdeManifest } from "./manifest"
import { validateIdeManifestSchema } from "./manifest-schema"

export interface DevFolderDiagnostic {
  code: string
  /** Where in `plugin.json`, when known. */
  field?: string
  message: string
}

export interface DevFolderDiagnosis {
  /** `false` when the manifest has no `ide` section: nothing to check. */
  managedIde: boolean
  diagnostics: DevFolderDiagnostic[]
  warnings: string[]
}

export function diagnoseDevFolderManifest(manifest: PluginManifest): DevFolderDiagnosis {
  const hasIde = manifest.ide !== undefined || hasLegacyIdeFields(manifest)
  if (!hasIde) return { managedIde: false, diagnostics: [], warnings: [] }
  const diagnostics: DevFolderDiagnostic[] = manifest.ide
    ? validateIdeManifestSchema(manifest.ide).map((entry) => ({
        code: entry.code,
        field: entry.field,
        message: entry.message,
      }))
    : []
  let warnings: string[] = []
  try {
    warnings = normalizeIdeManifest(manifest.id, manifest).warnings
  } catch (error) {
    const known = error instanceof IdeManifestError
    const message = error instanceof Error ? error.message : String(error)
    // The schema pass already reported a schema refusal, field by field.
    if (!(known && error.code === "IDE_MANIFEST_SCHEMA_INVALID" && diagnostics.length > 0)) {
      diagnostics.push({
        code: known ? error.code : "IDE_MANIFEST_INVALID",
        ...(known && error.field ? { field: error.field } : {}),
        message: known ? message.slice(error.code.length + 2) : message,
      })
    }
  }
  return { managedIde: true, diagnostics, warnings }
}

/** The legacy `vscode*` author fields normalization still reads (one major). */
function hasLegacyIdeFields(manifest: PluginManifest): boolean {
  const legacy = manifest as PluginManifest & {
    vscodeExtension?: { contributes?: unknown }
    vscodeLanguages?: unknown[]
    vscodeGrammars?: unknown[]
    vscodeIconThemes?: unknown[]
    vscodeSnippets?: unknown[]
  }
  return Boolean(
    legacy.vscodeExtension?.contributes ||
    legacy.vscodeLanguages?.length ||
    legacy.vscodeGrammars?.length ||
    legacy.vscodeIconThemes?.length ||
    legacy.vscodeSnippets?.length
  )
}
