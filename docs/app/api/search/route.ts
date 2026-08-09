import { source } from "@/lib/source"
import { createFromSource } from "fumadocs-core/search/server"

// Static export (D8): the search index is pre-rendered into a static JSON
// payload at build time; the client downloads it and searches locally (see
// components/search-dialog.tsx). Fumadocs' multilingual ZBSearch index keeps
// both configured locales in one database and the client filters by locale.
export const revalidate = false

export const { staticGET: GET } = createFromSource(source)
