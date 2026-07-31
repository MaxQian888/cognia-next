"use client"

/**
 * Static search dialog (D8). The exported Orama indexes are downloaded and
 * queried client-side; Chinese needs the mandarin tokenizer because Orama's
 * default tokenizer has no zh stemmer (build fails server-side, and a
 * whitespace tokenizer can't segment Chinese text client-side). Must stay in
 * sync with the `localeMap` in `app/api/search/route.ts`.
 */

import { create } from "@orama/orama"
import { createTokenizer } from "@orama/tokenizers/mandarin"
import { useDocsSearch } from "fumadocs-core/search/client"
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

function initOrama(locale?: string) {
  return create({
    schema: { _: "string" },
    ...(locale === "zh" ? { components: { tokenizer: createTokenizer() } } : { language: locale }),
  })
}

export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n()
  const { search, setSearch, query } = useDocsSearch({
    type: "static",
    initOrama,
    locale,
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
