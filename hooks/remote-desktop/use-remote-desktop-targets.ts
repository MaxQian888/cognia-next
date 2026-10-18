"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { CredentialChange } from "@/lib/remote-desktop/drafts"
import {
  deleteRemoteDesktopTarget,
  listRemoteDesktopTargets,
  RemoteDesktopError,
  saveRemoteDesktopTarget,
  setRemoteDesktopCredential,
  toRemoteDesktopError,
} from "@/lib/remote-desktop/host-client"
import type {
  RemoteDesktopHostRef,
  RemoteDesktopTarget,
  RemoteDesktopTargetDraft,
} from "@/lib/remote-desktop/types"

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

/** One string per Host, so a fresh ref object each render is the same Host. */
export function remoteDesktopHostKey(host: RemoteDesktopHostRef | null): string | null {
  if (!host) return null
  return host.kind === "local" ? "local" : `remote:${host.hostRef}`
}

/**
 * A Host's saved targets, and the writes that change them. Credentials are
 * stored after the target, in the same action, and never read back. `null`
 * means there is no Host to ask (yet).
 */
export function useRemoteDesktopTargets(
  hostRef: RemoteDesktopHostRef | null,
  deps: RemoteDesktopTargetsDeps = {}
) {
  const hostKey = remoteDesktopHostKey(hostRef)
  // Stable per Host: the effects below key on it, not on the caller's object.
  const host = useMemo<RemoteDesktopHostRef | null>(
    () =>
      hostKey === null
        ? null
        : hostKey === "local"
          ? { kind: "local" }
          : { kind: "remote", hostRef: hostKey.slice("remote:".length) },
    [hostKey]
  )
  const enabled = host !== null
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
    if (!host) return Promise.resolve()
    return list(host).then(
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
  }, [host, list])

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    await load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  const requireHost = useCallback((): RemoteDesktopHostRef => {
    if (!host) throw new RemoteDesktopError("remote_desktop_host_unavailable")
    return host
  }, [host])

  const saveTarget = useCallback(
    async (input: SaveTargetInput): Promise<SaveTargetResult> => {
      const at = requireHost()
      let target = await save(at, input.draft)
      let credentialError: RemoteDesktopError | undefined
      const binding = input.bindingOf(target)
      if (binding) {
        for (const [kind, change] of [
          ["control", input.control],
          ["view", input.view],
        ] as const) {
          if (change === undefined) continue
          try {
            target = await setCredential(at, target.id, binding.id, kind, change)
          } catch (caught) {
            credentialError ??= toRemoteDesktopError(caught)
          }
        }
      }
      await reload()
      return { target, credentialError }
    },
    [reload, requireHost, save, setCredential]
  )

  const deleteTarget = useCallback(
    async (targetId: string) => {
      await remove(requireHost(), targetId)
      await reload()
    },
    [reload, remove, requireHost]
  )

  return { host, targets, loading, error, reload, saveTarget, deleteTarget }
}
