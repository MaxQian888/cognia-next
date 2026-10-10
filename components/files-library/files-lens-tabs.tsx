"use client"

/**
 * The lenses above the Files list (ADR-0223): Suggested, Favorites, Mine,
 * AI-generated and Shared with me. A lens narrows whichever place the sidebar
 * picked; the Trash has no lenses, so it shows none.
 */

import { useTranslations } from "next-intl"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isFilesLens } from "@/lib/files-library/deep-link"
import { FILES_LENSES } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesLensTabs() {
  const t = useTranslations("files")
  const lens = useFilesLibraryStore((s) => s.lens)
  const setLens = useFilesLibraryStore((s) => s.setLens)
  const inTrash = useFilesLibraryStore((s) => s.section.kind === "trash")
  if (inTrash) return null

  return (
    <Tabs
      value={lens}
      onValueChange={(value) => {
        if (isFilesLens(value)) setLens(value)
      }}
    >
      <TabsList aria-label={t("lenses.aria")}>
        {FILES_LENSES.map((id) => (
          <TabsTrigger key={id} value={id} data-testid={`files-lens-${id}`}>
            {t(`lenses.${id}`)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
