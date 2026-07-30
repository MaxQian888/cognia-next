"use client"

import { useSyncExternalStore } from "react"
import {
  templateCatalog,
  type TemplateCatalog,
  type TemplateCatalogQuery,
} from "@/lib/templates/catalog"

export function useTemplateCatalog(
  query: TemplateCatalogQuery = {},
  catalog: TemplateCatalog = templateCatalog
) {
  const snapshot = useSyncExternalStore(
    catalog.subscribe,
    catalog.getSnapshot,
    catalog.getServerSnapshot
  )
  const { domain, status, source, trust, platform, text } = query
  const definitions = catalog.query({ domain, status, source, trust, platform, text })
  return { definitions, revision: snapshot.revision }
}
