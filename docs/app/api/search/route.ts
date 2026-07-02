import { createTokenizer } from "@orama/tokenizers/mandarin"

import { source } from "@/lib/source"
import { createFromSource } from "fumadocs-core/search/server"

// Static export (D8): the search index is pre-rendered into a static JSON
// payload at build time; the client downloads it and searches locally (see
// components/search-dialog.tsx — its tokenizer choice must match this one).
// Orama has no zh stemmer, so Chinese gets the mandarin word segmenter.
export const revalidate = false

export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    zh: { components: { tokenizer: createTokenizer() } },
  },
})
