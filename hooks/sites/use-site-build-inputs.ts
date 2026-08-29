"use client"

/**
 * The build form's inputs, seeded per Site.
 *
 * They used to be `useState` literals inside the publish tab, which meant they
 * reset on every visit and — worse — did *not* reset when the selection
 * changed, so Site A's runtime and network allowances were used for Site B's
 * build. Keyed on the Site id here, and seeded from that Site's own history.
 */
import { useMemo, useState } from "react"

import {
  seedSiteBuildInputs,
  type SiteBuildInputSource,
  type SiteBuildInputs,
} from "@/lib/sites/build-inputs"
import type { SiteHostingManifest } from "@/lib/sites/manifest"
import type { SiteVersionRow } from "@/types/sites"

export interface SiteBuildInputsController {
  inputs: SiteBuildInputs
  source: SiteBuildInputSource
  setInputs: (patch: Partial<SiteBuildInputs>) => void
}

export function useSiteBuildInputs(
  siteId: string | null,
  versions: readonly SiteVersionRow[],
  manifest?: SiteHostingManifest
): SiteBuildInputsController {
  // Only the install command is read off the manifest, and the controller
  // rebuilds that object on every read — so key on the command rather than on
  // object identity, which would re-seed on every render.
  const installKey = manifest?.build.install?.join(" ") ?? ""
  const seed = useMemo(
    () => seedSiteBuildInputs(versions, manifest),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [siteId, versions, installKey]
  )
  const [edits, setEdits] = useState<{ key: string | null; patch: Partial<SiteBuildInputs> }>({
    key: siteId,
    patch: {},
  })

  // Adjust while rendering rather than in an effect: the repo forbids
  // set-state-in-effect, and a one-frame flash of the previous Site's inputs is
  // exactly the bug this hook exists to remove.
  const patch = edits.key === siteId ? edits.patch : {}
  if (edits.key !== siteId) setEdits({ key: siteId, patch: {} })

  return {
    inputs: { ...seed.inputs, ...patch },
    source: Object.keys(patch).length > 0 ? "default" : seed.source,
    setInputs: (next) =>
      setEdits((current) => ({
        key: siteId,
        patch: current.key === siteId ? { ...current.patch, ...next } : next,
      })),
  }
}
