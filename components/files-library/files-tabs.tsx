"use client"

import { useTranslations } from "next-intl"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FILES_TABS, type FilesTab } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

function isFilesTab(value: string): value is FilesTab {
  return (FILES_TABS as readonly string[]).includes(value)
}

/** Recent / Favorites / Folders / Images / All. */
export function FilesTabs() {
  const t = useTranslations("files")
  const tab = useFilesLibraryStore((s) => s.tab)
  const setTab = useFilesLibraryStore((s) => s.setTab)

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isFilesTab(value)) setTab(value)
      }}
    >
      <TabsList aria-label={t("tabsAria")}>
        {FILES_TABS.map((id) => (
          <TabsTrigger key={id} value={id} data-testid={`files-tab-${id}`}>
            {t(`tabs.${id}`)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
