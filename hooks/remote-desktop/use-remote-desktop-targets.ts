"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { CredentialChange } from "@/lib/remote-desktop/drafts"
import {
  deleteRemoteDesktopTarget,
  listRemoteDesktopTargets,
  RemoteDesktopError,
  saveRemoteDesktopTarget,
  setRemoteDesktopCredential,
  toRemoteDesktopError,
} from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopTarget, RemoteDesktopTargetDraft } from "@/lib/remote-desktop/types"

export interface RemoteDesktopTargetsDeps {
  list?: typeof listRemoteDesktopTargets
  save?: typeof saveRemoteDesktopTarget
  remove?: typeof deleteRemoteDesktopTarget
  setCredential?: typeof setRemoteDesktopCredential
}

export interface SaveTargetInput {
  draft: RemoteDesktopTargetDraft
  /** Picks the saved binding the credentials belong to. */
  bindingOf: (saved: RemoteDesktopTarget) => { id: string } | undefined
  control?: CredentialChange
  view?: CredentialChange
}

export interface SaveTargetResult {
  target: RemoteDesktopTarget
  /** The target saved but a credential did not; the message says why. */
  credentialError?: RemoteDesktopError
}

/**
 * The Host's saved targets, and the writes that change them. Credentials are
 * stored after the target, in the same action, and never read back.
 */
export function useRemoteDesktopTargets(enabled: boolean, deps: RemoteDesktopTargetsDeps = {}) {
  const list = deps.list ?? listRemoteDesktopTargets
  const save = deps.save ?? saveRemoteDesktopTarget
  const remove = deps.remove ?? deleteRemoteDesktopTarget
  const setCredential = deps.setCredential ?? setRemoteDesktopCredential
  const [targets, setTargets] = useState<RemoteDesktopTarget[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<RemoteDesktopError | null>(null)
  const generation = useRef(0)

  /** Fetch and publish; state changes only once the Host answers. */
  const load = useCallback((): Promise<void> => {
    const current = ++generation.current
    return list().then(
      (next) => {
        if (current !== generation.current) return
        setTargets(next)
        setError(null)
        setLoading(false)
      },
      (caught: unknown) => {
        if (current !== generation.current) return
        setError(toRemoteDesktopError(caught))
        setLoading(false)
      }
    )
  }, [list])

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    await load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  const saveTarget = useCallback(
    async (input: SaveTargetInput): Promise<SaveTargetResult> => {
      let target = await save(input.draft)
      let credentialError: RemoteDesktopError | undefined
      const binding = input.bindingOf(target)
      if (binding) {
        for (const [kind, change] of [
          ["control", input.control],
          ["view", input.view],
        ] as const) {
          if (change === undefined) continue
          try {
            target = await setCredential(target.id, binding.id, kind, change)
          } catch (caught) {
            credentialError ??= toRemoteDesktopError(caught)
          }
        }
      }
      await reload()
      return { target, credentialError }
    },
    [reload, save, setCredential]
  )

  const deleteTarget = useCallback(
    async (targetId: string) => {
      await remove(targetId)
      await reload()
    },
    [reload, remove]
  )

  return { targets, loading, error, reload, saveTarget, deleteTarget }
}
