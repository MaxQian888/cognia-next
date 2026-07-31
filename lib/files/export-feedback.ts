"use client"

/**
 * Toast feedback for {@link saveExport} outcomes — the "where did my file go?"
 * fix. Tells the user the save location and offers a platform-appropriate
 * follow-up action:
 *   - Tauri:     "Show in folder" → `revealItemInDir`
 *   - Capacitor: "Share"          → system share sheet on the saved file
 *   - Web:       location hint only (browser owns the Downloads folder)
 *
 * Follows the translator-injection pattern of `lib/skills/export-toast.ts`
 * (the caller passes its `useTranslations("export")` instance) rather than
 * reaching for i18n inside a lib module. Distinct from that helper, which
 * reports a *directory batch* write; this one is for single-file saves.
 */

import { toast } from "sonner"
import { revealItemInDir } from "@/lib/native/opener"
import { share } from "@/lib/capacitor/share"
import type { SaveExportOutcome } from "@/lib/files/save-export"

type TranslatorValues = Record<string, string | number | Date>
type Translator = (key: string, vars?: TranslatorValues) => string

export interface ExportFeedbackOptions {
  /** Translator scoped to the `export` namespace (keys under `export.location.*`). */
  t: Translator
  /** Title used for the mobile system share sheet. */
  shareTitle?: string
}

/** Surface a toast describing where an export landed (and how to reach it). */
export function notifyExportOutcome(
  outcome: SaveExportOutcome,
  { t, shareTitle }: ExportFeedbackOptions
): void {
  if (outcome.kind === "cancelled") return

  if (outcome.kind === "error") {
    toast.error(t("location.exportFailed", { message: outcome.message }))
    return
  }

  if (outcome.platform === "web") {
    toast.success(t("location.savedToDownloads", { filename: outcome.filename }))
    return
  }

  if (outcome.platform === "tauri") {
    toast.success(t("location.savedToPath", { path: outcome.location }), {
      action: {
        label: t("location.revealInFolder"),
        onClick: () => {
          void revealItemInDir(outcome.location)
        },
      },
    })
    return
  }

  // mobile — saved into the Files app; offer the native share sheet.
  const uri = outcome.uri ?? outcome.location
  toast.success(t("location.savedToPath", { path: outcome.location }), {
    action: {
      label: t("location.shareFile"),
      onClick: () => {
        void share({ title: shareTitle, files: [uri] })
      },
    },
  })
}
