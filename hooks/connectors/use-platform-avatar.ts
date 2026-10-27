"use client"

import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react"
import { getDb } from "@/lib/db/schema"
import { useLiveQuery } from "dexie-react-hooks"
import { getCredentialsGeneration, onCredentialsRotated } from "@/lib/connectors/credentials-events"
import {
  AVATAR_RETRY_MS,
  AVATAR_TTL_MS,
  avatarConfigKey,
  inlineAvatarUrl,
  resolvePlatformAvatar,
  type PlatformAvatarTarget,
} from "@/lib/connectors/platform-avatar"

/** Image bytes are presentation-only; late account/identity results cannot paint a new person. */
export function usePlatformAvatar(target: PlatformAvatarTarget | null): string | undefined {
  const targetKey = JSON.stringify(target)
  const inline = inlineAvatarUrl(target?.avatarUrl)
  const scope = target && !inline && typeof window !== "undefined" ? getDb().name : ""
  const adapterId = target?.adapterId
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!adapterId || inline) return () => {}
      return onCredentialsRotated((event) => {
        if (event.adapterId === adapterId) listener()
      })
    },
    [adapterId, inline]
  )
  const credentialGeneration = useSyncExternalStore(
    subscribe,
    () => (adapterId && !inline ? getCredentialsGeneration(adapterId) : "0"),
    () => "0"
  )
  const adapter = useLiveQuery(
    () => (scope && adapterId ? getDb().adapterInstances.get(adapterId) : undefined),
    [scope, adapterId]
  )
  const configKey = adapter ? avatarConfigKey(adapter) : undefined
  const key = JSON.stringify([scope, targetKey, configKey, credentialGeneration])
  const [state, setState] = useState<{ key: string; url?: string }>()
  const [, resyncRevision] = useReducer((revision: number) => revision + 1, 0)
  useEffect(() => {
    const current = JSON.parse(targetKey) as PlatformAvatarTarget | null
    if (!current || !scope || !configKey) return
    let retired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const isCurrent = () => {
      if (retired || getDb().name !== scope) return false
      if (getCredentialsGeneration(current.adapterId) !== credentialGeneration) {
        // Storage may become readable without a storage event. Reconcile this
        // hook's snapshot so a discarded result does not abandon its refresh.
        resyncRevision()
        return false
      }
      return true
    }
    const refresh = async () => {
      if (!isCurrent()) return
      const url = await resolvePlatformAvatar({
        ...current,
        configKey,
        credentialGeneration,
      }).catch(() => undefined)
      if (!isCurrent()) return
      setState((previous) =>
        previous?.key === key && previous.url === url ? previous : { key, url }
      )
      timer = setTimeout(
        () => {
          void refresh()
        },
        url ? AVATAR_TTL_MS : AVATAR_RETRY_MS
      )
    }
    void refresh()
    return () => {
      retired = true
      clearTimeout(timer)
    }
  }, [targetKey, scope, key, configKey, credentialGeneration])
  return inline ?? (state?.key === key ? state.url : undefined)
}
