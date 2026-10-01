"use client"

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useCogsetSwitch } from "@/components/plugins/cogsets/use-cogset-switch"
import { useCogsetDisplayName, useInstalledPluginSummaries } from "@/hooks/plugins/use-cogsets"
import { getCogset } from "@/lib/db/plugin-cogsets"
import { COGPACK_FILE_EXTENSION, COGPACK_MIME_TYPE } from "@/types/plugin/plugin-cogset"

import { CogpackImportDialog, type CogpackImportFile } from "./cogpack-import-dialog"

export interface CogpackImportController {
  /** Opens the file picker; the review opens once a file is chosen. */
  pick: () => void
  element: ReactNode
}

/**
 * Pick a `.cogpack`, review it, import it, and offer to switch to the result.
 * Shared by the cogset switcher and the toolbar's Install menu.
 */
export function useCogpackImport(): CogpackImportController {
  const t = useTranslations("plugins.cogpacks.import")
  const displayName = useCogsetDisplayName()
  const { byId } = useInstalledPluginSummaries()
  const pluginName = useCallback((pluginId: string) => byId.get(pluginId)?.name ?? pluginId, [byId])
  const switcher = useCogsetSwitch({ displayName, pluginName })
  const [file, setFile] = useState<CogpackImportFile | null>(null)

  const pick = useCallback(() => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = `${COGPACK_FILE_EXTENSION},${COGPACK_MIME_TYPE},application/zip`
    input.onchange = () => {
      const chosen = input.files?.[0]
      if (!chosen) return
      void chosen
        .arrayBuffer()
        .then((buffer) => setFile({ name: chosen.name, bytes: new Uint8Array(buffer) }))
        .catch((error: unknown) =>
          toast.error(t("openFailed", { file: chosen.name }), {
            description: error instanceof Error ? error.message : String(error),
          })
        )
    }
    input.click()
  }, [t])

  const element = (
    <>
      <CogpackImportDialog
        file={file}
        onOpenChange={(open) => !open && setFile(null)}
        pluginName={pluginName}
        onSwitch={(cogsetId) => {
          void getCogset(cogsetId).then((cogset) => cogset && switcher.request(cogset))
        }}
      />
      {switcher.element}
    </>
  )

  return { pick, element }
}
