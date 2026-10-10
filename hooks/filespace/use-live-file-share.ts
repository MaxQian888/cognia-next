"use client"

/**
 * A host's live file sharing, read for a surface (ADR-0222 §7.5): the
 * service's status and its grants, either one conversation's or all of them.
 *
 * Which host: `hostId` names a conversation's FileSpace host (see
 * `fileShareTransport`), `transport` a specific one (Settings drives the
 * active host through the routed transport). A `transport` must be stable
 * across renders; module-level transports are.
 *
 * The last answer stays on screen while a reload runs, as long as it was for
 * the same conversation and host, so acting on a grant does not blank the
 * list. A routed `transport` can start pointing at another Host (a pairing
 * swaps it, the desktop switches the remote it drives); either change reads
 * again rather than showing the previous Host's shares.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import {
  fileShareErrorDetails,
  getFileShareStatus,
  listLiveGrants,
  type FileShareErrorCode,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareStatus, LiveGrantView } from "@/types/filespace/live"

export interface UseLiveFileShareOptions {
  /** One conversation's grants; every grant when absent. */
  sessionId?: string | null
  hostId?: string
  transport?: Transport
  /** False skips the reads (no host to ask). */
  enabled?: boolean
}

export interface LiveFileShareState {
  status: FileShareStatus | null
  grants: LiveGrantView[]
  /** Why the host could not be read; `null` after a good read. */
  error: FileShareErrorCode | "unknown" | null
  /** The host's own words for `error`, for a sentence that quotes them. */
  errorMessage: string | null
  /** A read for the current inputs has not answered yet. */
  loading: boolean
  reload: () => void
}

interface Answer {
  scope: string
  request: string
  status: FileShareStatus | null
  grants: LiveGrantView[]
  error: FileShareErrorCode | "unknown" | null
  errorMessage: string | null
}

/** Bumped whenever the routed transport may reach a different Host. */
let transportEpoch = 0

function subscribeTransportEpoch(onChange: () => void): () => void {
  const bump = () => {
    transportEpoch += 1
    onChange()
  }
  const stopSwap = onTransportChange(bump)
  const stopRemote = subscribeActiveRemoteTransport(bump)
  return () => {
    stopSwap()
    stopRemote()
  }
}

const readTransportEpoch = () => transportEpoch

export function useLiveFileShare({
  sessionId = null,
  hostId,
  transport,
  enabled = true,
}: UseLiveFileShareOptions): LiveFileShareState {
  const [nonce, setNonce] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const epoch = useSyncExternalStore(
    subscribeTransportEpoch,
    readTransportEpoch,
    readTransportEpoch
  )
  const scope = `${sessionId ?? "*"}|${transport ? `transport:${epoch}` : (hostId ?? "")}`
  const request = `${scope}|${nonce}`

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const target: FileShareTarget = transport ? { transport } : { hostId }
    Promise.all([
      getFileShareStatus(target),
      listLiveGrants(sessionId ? { sessionId } : {}, target),
    ]).then(
      ([status, grants]) => {
        if (!cancelled) {
          setAnswer({ scope, request, status, grants, error: null, errorMessage: null })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          const { code, message } = fileShareErrorDetails(error)
          setAnswer({
            scope,
            request,
            status: null,
            grants: [],
            error: code,
            errorMessage: message,
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, sessionId, hostId, transport, scope, request])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  const shown = enabled && answer?.scope === scope ? answer : null
  return {
    status: shown?.status ?? null,
    grants: shown?.grants ?? [],
    error: shown?.error ?? null,
    errorMessage: shown?.errorMessage ?? null,
    loading: enabled && answer?.request !== request,
    reload,
  }
}
