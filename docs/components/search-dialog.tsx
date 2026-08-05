"use client"

/**
 * Static search dialog (D8). The exported Orama indexes are downloaded and
 * queried client-side. Fumadocs' multilingual ZBSearch index handles both
 * configured locales and filters results to the active locale.
 */

import { useDocsSearch } from "fumadocs-core/search/client"
import { staticClient } from "fumadocs-core/search/client/orama-static"
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search"
import { useI18n } from "fumadocs-ui/contexts/i18n"

export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n()
  const { search, setSearch, query } = useDocsSearch({
    client: staticClient({ locale }),
  })

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  )
}
