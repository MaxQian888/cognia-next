"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  closeRemoteDesktopSession,
  openRemoteDesktopSession,
  REMOTE_DESKTOP_RENEW_MS,
  RemoteDesktopError,
  renewRemoteDesktopSession,
  toRemoteDesktopError,
} from "@/lib/remote-desktop/host-client"
import type {
  RemoteDesktopSessionMode,
  RemoteDesktopSessionOpened,
} from "@/lib/remote-desktop/types"

export interface RemoteDesktopSessionDeps {
  open?: typeof openRemoteDesktopSession
  renew?: typeof renewRemoteDesktopSession
  close?: typeof closeRemoteDesktopSession
  renewMs?: number
}

export type RemoteDesktopSessionState =
  | { status: "idle" }
  | { status: "opening"; mode: RemoteDesktopSessionMode }
  | { status: "open"; session: RemoteDesktopSessionOpened }
  /** Someone else controls the target; the user chooses take over or view. */
  | { status: "busy" }
  | { status: "ended"; error?: RemoteDesktopError }

/**
 * One Host session for one binding (ADR-0234 Phase 2 item 6). It renews every
 * five seconds; the Host closes a session after 15 s without, so a crashed or
 * hidden page never holds control. Opening again (reconnect, take control,
 * stop controlling) closes the previous session first.
 */
export function useRemoteDesktopSession(
  target: { targetId: string; bindingId: string } | null,
  deps: RemoteDesktopSessionDeps = {}
) {
  // Held in a ref: a caller passing fresh functions each render must not
  // re-run the effects below, whose cleanup closes the live session.
  const io = useRef({
    open: deps.open ?? openRemoteDesktopSession,
    renew: deps.renew ?? renewRemoteDesktopSession,
    close: deps.close ?? closeRemoteDesktopSession,
  })
  useLayoutEffect(() => {
    io.current = {
      open: deps.open ?? openRemoteDesktopSession,
      renew: deps.renew ?? renewRemoteDesktopSession,
      close: deps.close ?? closeRemoteDesktopSession,
    }
  })
  const renewMs = deps.renewMs ?? REMOTE_DESKTOP_RENEW_MS
  const [state, setState] = useState<RemoteDesktopSessionState>({ status: "idle" })
  const current = useRef<string | null>(null)
  const generation = useRef(0)
  const targetId = target?.targetId
  const bindingId = target?.bindingId

  const release = useCallback(() => {
    const sessionId = current.current
    current.current = null
    if (sessionId) void io.current.close(sessionId).catch(() => undefined)
  }, [])

  const connect = useCallback(
    async (mode: RemoteDesktopSessionMode, takeover = false) => {
      if (!targetId || !bindingId) return
      const attempt = ++generation.current
      release()
      setState({ status: "opening", mode })
      try {
        const session = await io.current.open({ targetId, bindingId, mode, takeover })
        if (attempt !== generation.current) {
          void io.current.close(session.sessionId).catch(() => undefined)
          return
        }
        current.current = session.sessionId
        setState({ status: "open", session })
      } catch (caught) {
        if (attempt !== generation.current) return
        const error = toRemoteDesktopError(caught)
        setState(
          error.code === "remote_desktop_control_busy"
            ? { status: "busy" }
            : { status: "ended", error }
        )
      }
    },
    [bindingId, release, targetId]
  )

  const disconnect = useCallback(() => {
    generation.current += 1
    release()
    setState({ status: "ended" })
  }, [release])

  /** The viewer reported the session ended on its own (server, network). */
  const markEnded = useCallback(
    (error?: RemoteDesktopError) => {
      generation.current += 1
      release()
      setState({ status: "ended", error })
    },
    [release]
  )

  const sessionId = state.status === "open" ? state.session.sessionId : null
  useEffect(() => {
    if (!sessionId) return
    const timer = setInterval(() => {
      io.current
        .renew(sessionId)
        .then((renewed) =>
          setState((previous) =>
            previous.status === "open" && previous.session.sessionId === sessionId
              ? {
                  status: "open",
                  session: {
                    ...previous.session,
                    expiresAt: renewed.expiresAt,
                    lease: renewed.lease,
                  },
                }
              : previous
          )
        )
        .catch((caught) => {
          if (current.current !== sessionId) return
          current.current = null
          setState({ status: "ended", error: toRemoteDesktopError(caught) })
        })
    }, renewMs)
    return () => clearInterval(timer)
  }, [renewMs, sessionId])

  // Leaving the page ends the session at once rather than after the timeout.
  useEffect(
    () => () => {
      generation.current += 1
      release()
    },
    [release]
  )

  return { state, connect, disconnect, markEnded }
}
