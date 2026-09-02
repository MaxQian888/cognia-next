"use client"

/**
 * The template instance one Squad was created from, if any.
 *
 * `TemplateInstanceRecord.resources` is the only link between a template and
 * the thing it produced. The agentTeam adapter records exactly one resource per
 * instantiation, `{ domain: "agentTeam", id: <teamId> }`, so finding a Squad's
 * lineage is a scan for that pair rather than anything the Squad itself
 * carries. That is deliberate in ADR-0100: the definition stays portable and
 * the instance is the local record of "a template was used here".
 *
 * Reading every instance is not a shortcut. `listInstances` has no by-resource
 * index, the row count is bounded by how many templates this user has
 * instantiated, and the alternative would be a second index in Dexie for a
 * lookup that happens when a settings pane opens.
 *
 * The nonce is what makes update and detach visible: both write through the
 * service, which does not notify the catalog subscribers this pane also reads,
 * so the caller bumps it after a write instead of the pane guessing.
 *
 * `loading` is derived from which read has landed rather than set at the top of
 * the effect. A bare `setLoading(true)` in an effect body is a cascading render
 * every time the Squad changes, and the house lint rule catches exactly that.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { templateCatalog, type TemplateCatalog } from "@/lib/templates/catalog"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"

export interface SquadTemplateInstance {
  /** Absent when this Squad predates lineage, or was duplicated from another. */
  instance?: TemplateInstanceRecord
  /** Releases of the source definition this instance could move to. */
  availableVersions: string[]
  /** The definition's display name, from its own snapshot. */
  templateName?: string
  loading: boolean
  /** Re-read after an update or a detach. */
  refresh: () => void
}

/**
 * `runtime` is an effect dependency, so it must be stable across renders.
 * Production passes the process singleton `getTemplateRuntime()` returns, and
 * a test should hoist the object it injects out of the render body.
 */
export function useSquadTemplateInstance(
  squadId: string | undefined,
  runtime: TemplateRuntime = getTemplateRuntime(),
  // The runtime's own catalog by default: a caller that injects a runtime
  // injects the catalog with it.
  catalog: TemplateCatalog = runtime.catalog ?? templateCatalog
): SquadTemplateInstance {
  const [nonce, setNonce] = useState(0)
  // The read that has landed, tagged with the request it answered. Comparing
  // that tag to the current one is what `loading` means here.
  const [landed, setLanded] = useState<{ key: string; instance?: TemplateInstanceRecord }>({
    key: "",
  })
  const key = `${squadId ?? ""}#${nonce}`

  useEffect(() => {
    let active = true
    // The empty case resolves through the same promise rather than settling
    // synchronously, so there is one code path and no setState in the body.
    const load = squadId
      ? runtime.repository.listInstances()
      : Promise.resolve([] as TemplateInstanceRecord[])
    void load
      .then((records) => {
        if (!active) return
        const found = records.find((record) =>
          record.resources.some(
            (resource) => resource.domain === "agentTeam" && resource.id === squadId
          )
        )
        setLanded(found ? { key, instance: found } : { key })
      })
      .catch(() => {
        if (!active) return
        setLanded({ key })
      })
    return () => {
      active = false
    }
  }, [key, squadId, runtime])

  const instance = landed.key === key ? landed.instance : undefined
  const definitionId = instance?.source.definitionId
  const availableVersions = useMemo(() => {
    if (!definitionId) return []
    return catalog
      .getSnapshot()
      .definitions.filter(
        (definition) =>
          definition.id === definitionId &&
          definition.version !== null &&
          definition.status !== "yanked" &&
          definition.status !== "tombstone"
      )
      .map((definition) => definition.version!)
  }, [catalog, definitionId])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return {
    ...(instance ? { instance } : {}),
    availableVersions,
    ...(instance ? { templateName: instance.source.snapshot.metadata.name } : {}),
    loading: landed.key !== key,
    refresh,
  }
}
