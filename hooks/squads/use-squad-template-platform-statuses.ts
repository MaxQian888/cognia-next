"use client"

/**
 * Platform status for every user-owned row in the squad templates gallery.
 *
 * The gallery lists three kinds of template that reach the platform three
 * different ways, and only one of them is the user's to publish, export or
 * fork. This reads the status of that one kind in a single pass, so a row can
 * say "draft" or "v1.2.0" instead of the gallery guessing from the store, which
 * knows nothing about releases at all.
 *
 * `rows` is deliberately NOT an effect dependency. A caller whose list is a new
 * array every render (a store selector that returns a fresh object, say) would
 * otherwise re-run the read, set state, and spin. What identifies a read is the
 * set of template ids plus the refresh counter, so the rows are pinned to that
 * key during render and the effect depends on the pinned pair.
 */

import { useCallback, useEffect, useState } from "react"

import {
  readSquadTemplatePlatformStatus,
  type SquadTemplateOrigin,
  type SquadTemplatePlatformStatus,
} from "@/lib/agent-team/squad-template-platform"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

export interface SquadTemplateStatusRow {
  template: AgentTeamTemplate
  origin?: SquadTemplateOrigin
}

export interface SquadTemplateStatuses {
  /** Keyed by the template's own store id, not by its definition id. */
  byTemplateId: Record<string, SquadTemplatePlatformStatus>
  loading: boolean
  refresh: () => void
}

export function useSquadTemplatePlatformStatuses(
  rows: readonly SquadTemplateStatusRow[],
  runtime: TemplateRuntime = getTemplateRuntime()
): SquadTemplateStatuses {
  const [nonce, setNonce] = useState(0)
  const [landed, setLanded] = useState<{
    key: string
    byTemplateId: Record<string, SquadTemplatePlatformStatus>
  }>({ key: "", byTemplateId: {} })

  const key = `${rows.map((row) => row.template.id).join("|")}#${nonce}`

  // Adjust-state-during-render (react.dev, "You Might Not Need an Effect"):
  // pins the rows to the key that identifies them, so the effect below has one
  // dependency whose identity changes exactly when the work does.
  const [pinned, setPinned] = useState({ key, rows })
  if (pinned.key !== key) setPinned({ key, rows })

  useEffect(() => {
    let active = true
    void Promise.all(
      pinned.rows.map(async (row) => {
        const status = await readSquadTemplatePlatformStatus(
          row.template,
          row.origin ?? {},
          runtime
        )
        return [row.template.id, status] as const
      })
    )
      .then((entries) => {
        if (!active) return
        setLanded({ key: pinned.key, byTemplateId: Object.fromEntries(entries) })
      })
      .catch(() => {
        // A failed read is "we do not know", which renders as no badge and no
        // actions rather than as a wrong badge.
        if (!active) return
        setLanded({ key: pinned.key, byTemplateId: {} })
      })
    return () => {
      active = false
    }
  }, [pinned, runtime])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return {
    byTemplateId: landed.key === key ? landed.byTemplateId : {},
    loading: landed.key !== key,
    refresh,
  }
}
