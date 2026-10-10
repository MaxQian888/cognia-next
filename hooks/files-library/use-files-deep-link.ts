"use client"

/**
 * The Files page's URL (ADR-0223): `?section=` carries the place, `?tab=` the
 * lens and `?item=` the previewed item (what ⌘K links to). ADR-0200's `?tab=`
 * values still resolve and are rewritten.
 *
 * The URL is applied to the view, and the URL then follows the place and lens
 * the person picks. Writes read the store directly, so the first pass never
 * overwrites a deep link with the defaults it is about to replace.
 */

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import {
  filesLocationHref,
  parseFilesLocation,
  sameFilesSection,
} from "@/lib/files-library/deep-link"
import { useFilesLibraryStore } from "@/stores/files-library"

export function useFilesDeepLink(): void {
  const router = useRouter()
  const params = useSearchParams()
  const section = useFilesLibraryStore((s) => s.section)
  const lens = useFilesLibraryStore((s) => s.lens)
  const query = params?.toString() ?? ""

  useEffect(() => {
    const { location, legacy } = parseFilesLocation(new URLSearchParams(query))
    const store = useFilesLibraryStore.getState()
    if (location.section && !sameFilesSection(location.section, store.section)) {
      store.setSection(location.section)
    }
    if (location.lens && location.lens !== store.lens) store.setLens(location.lens)
    if (location.item) store.select(location.item)
    if (legacy) router.replace(filesLocationHref(location))
  }, [query, router])

  useEffect(() => {
    const store = useFilesLibraryStore.getState()
    const { location } = parseFilesLocation(new URLSearchParams(query))
    const urlSection = location.section ?? { kind: "all" as const }
    const urlLens = location.lens ?? "suggested"
    if (sameFilesSection(urlSection, store.section) && urlLens === store.lens) return
    router.replace(filesLocationHref({ section: store.section, lens: store.lens }))
    // `query` is read, not watched: only a change the person made writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, lens, router])
}
