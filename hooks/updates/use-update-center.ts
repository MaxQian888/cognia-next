"use client"

/**
 * React binding for the update coordinator.
 *
 * The coordinator is a plain module so the CLI and tests can drive it without
 * React. This hook is the only place that subscribes to it, and it hands back
 * rows already grouped the way the Update Center renders them.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"

import { ASSET_KIND_GROUP, UPDATE_GROUP_ORDER, type UpdateGroup } from "@cognia/agent-config-types"

import type { UpdateItem } from "@/lib/updates/adapter"
import type { UpdateCoordinator } from "@/lib/updates/coordinator"
import { getUpdateCoordinator } from "@/lib/updates/runtime"

export interface UpdateGroupView {
  group: UpdateGroup
  items: UpdateItem[]
}

export interface UseUpdateCenter {
  items: UpdateItem[]
  groups: UpdateGroupView[]
  /** Rows with something the user could act on right now. */
  actionable: UpdateItem[]
  /** Critical rows that are still outstanding. */
  critical: UpdateItem[]
  checking: boolean
  check: (manual?: boolean) => Promise<void>
  apply: (key: string, consented?: boolean) => Promise<void>
  skip: (key: string) => Promise<void>
  defer: (key: string) => Promise<void>
  clearHold: (key: string) => Promise<void>
}

const EMPTY: UpdateItem[] = []

export function useUpdateCenter(
  coordinator: UpdateCoordinator = getUpdateCoordinator()
): UseUpdateCenter {
  const items = useSyncExternalStore(
    useCallback((listener) => coordinator.subscribe(listener), [coordinator]),
    useCallback(() => coordinator.getItems(), [coordinator]),
    () => EMPTY
  )

  const groups = useMemo(
    () =>
      UPDATE_GROUP_ORDER.map((group) => ({
        group,
        items: items.filter((item) => ASSET_KIND_GROUP[item.kind] === group),
      })).filter((entry) => entry.items.length > 0),
    [items]
  )

  const actionable = useMemo(
    () =>
      items.filter(
        (item) =>
          item.candidate !== null &&
          (item.state === "available" ||
            item.state === "awaiting-consent" ||
            item.state === "awaiting-restart" ||
            item.state === "awaiting-reload")
      ),
    [items]
  )

  const critical = useMemo(
    () => actionable.filter((item) => item.candidate?.criticality === "critical"),
    [actionable]
  )

  const checking = useMemo(() => items.some((item) => item.state === "checking"), [items])

  return {
    items,
    groups,
    actionable,
    critical,
    checking,
    check: useCallback(
      async (manual = true) => {
        await coordinator.check({ manual })
      },
      [coordinator]
    ),
    apply: useCallback(
      async (key, consented = true) => {
        await coordinator.apply(key, { consented })
      },
      [coordinator]
    ),
    skip: useCallback(
      async (key) => {
        await coordinator.skip(key)
      },
      [coordinator]
    ),
    defer: useCallback(
      async (key) => {
        await coordinator.defer(key)
      },
      [coordinator]
    ),
    clearHold: useCallback(
      async (key) => {
        await coordinator.clearHold(key)
      },
      [coordinator]
    ),
  }
}
