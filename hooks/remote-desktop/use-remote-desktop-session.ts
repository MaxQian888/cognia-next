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
import {
  openRemoteDesktopStream,
  type RemoteDesktopConnection,
  type RemoteDesktopStream,
} from "@/lib/remote-desktop/stream"
import type {
  RemoteDesktopHostRef,
  RemoteDesktopSessionMode,
  RemoteDesktopSessionOpened,
} from "@/lib/remote-desktop/types"

export interface RemoteDesktopSessionDeps {
  open?: typeof openRemoteDesktopSession
  renew?: typeof renewRemoteDesktopSession
  close?: typeof closeRemoteDesktopSession
  openStream?: typeof openRemoteDesktopStream
  renewMs?: number
}

export type RemoteDesktopSessionState =
  | { status: "idle" }
  | { status: "opening"; mode: RemoteDesktopSessionMode }
  | {
      status: "open"
      session: RemoteDesktopSessionOpened
      /** What the viewer connects to: a URL, or an attached channel. */
      connection: RemoteDesktopConnection
    }
  /** Someone else controls the target; the user chooses take over or view. */
  | { status: "busy" }
  | { status: "ended"; error?: RemoteDesktopError }

interface Live {
  sessionId: string
  stream: RemoteDesktopStream | null
}

/**
 * One Host session for one binding (ADR-0234 Phases 2 and 3). It opens the
 * session, then the stream its viewer connects to (the loopback URL, a
 * ticketed Companion socket, or an attached `cognia.rfb` channel), and renews
 * every five seconds; the Host closes a session after 15 s without, so a
 * crashed or hidden page never holds control. Opening again (reconnect, take
 * control, stop controlling) closes the previous session first.
 */
export function useRemoteDesktopSession(
  host: RemoteDesktopHostRef | null,
  target: { targetId: string; bindingId: string } | null,
  deps: RemoteDesktopSessionDeps = {}
) {
  // Held in a ref: a caller passing fresh functions or a fresh host object
  // each render must not re-run the effects below, whose cleanup closes the
  // live session.
  const io = useRef({
    host,
    open: deps.open ?? openRemoteDesktopSession,
    renew: deps.renew ?? renewRemoteDesktopSession,
    close: deps.close ?? closeRemoteDesktopSession,
    openStream: deps.openStream ?? openRemoteDesktopStream,
  })
  useLayoutEffect(() => {
    io.current = {
      host,
      open: deps.open ?? openRemoteDesktopSession,
      renew: deps.renew ?? renewRemoteDesktopSession,
      close: deps.close ?? closeRemoteDesktopSession,
      openStream: deps.openStream ?? openRemoteDesktopStream,
    }
  })
  const renewMs = deps.renewMs ?? REMOTE_DESKTOP_RENEW_MS
  const [state, setState] = useState<RemoteDesktopSessionState>({ status: "idle" })
  const current = useRef<Live | null>(null)
  // The Host each live session was opened on, so release reaches the same one.
  const openedOn = useRef<RemoteDesktopHostRef | null>(null)
  const generation = useRef(0)
  const targetId = target?.targetId
  const bindingId = target?.bindingId

  const release = useCallback(() => {
    const live = current.current
    const at = openedOn.current
    current.current = null
    if (!live || !at) return
    live.stream?.close()
    void io.current.close(at, live.sessionId).catch(() => undefined)
  }, [])

  const connect = useCallback(
    async (mode: RemoteDesktopSessionMode, takeover = false) => {
      const at = io.current.host
      if (!targetId || !bindingId || !at) return
      const attempt = ++generation.current
      release()
      setState({ status: "opening", mode })
      let session: RemoteDesktopSessionOpened
      try {
        session = await io.current.open(at, { targetId, bindingId, mode, takeover })
      } catch (caught) {
        if (attempt !== generation.current) return
        const error = toRemoteDesktopError(caught)
        setState(
          error.code === "remote_desktop_control_busy"
            ? { status: "busy" }
            : { status: "ended", error }
        )
        return
      }
      const abandon = (stream?: RemoteDesktopStream) => {
        stream?.close()
        void io.current.close(at, session.sessionId).catch(() => undefined)
      }
      if (attempt !== generation.current) {
        abandon()
        return
      }
      // Held from here so leaving mid-attach still closes the session.
      current.current = { sessionId: session.sessionId, stream: null }
      openedOn.current = at
      let stream: RemoteDesktopStream
      try {
        stream = await io.current.openStream(at, session)
      } catch (caught) {
        if (current.current?.sessionId === session.sessionId) current.current = null
        abandon()
        if (attempt !== generation.current) return
        setState({ status: "ended", error: toRemoteDesktopError(caught) })
        return
      }
      if (attempt !== generation.current || current.current?.sessionId !== session.sessionId) {
        abandon(stream)
        return
      }
      current.current = { sessionId: session.sessionId, stream }
      setState({ status: "open", session, connection: stream.connection })
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
      const at = openedOn.current
      if (!at) return
      io.current
        .renew(at, sessionId)
        .then((renewed) =>
          setState((previous) =>
            previous.status === "open" && previous.session.sessionId === sessionId
              ? {
                  ...previous,
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
          if (current.current?.sessionId !== sessionId) return
          const live = current.current
          current.current = null
          live.stream?.close()
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
