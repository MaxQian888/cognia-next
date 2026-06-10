/**
 * Owns the live `AgentSession` and drives turns from the React side. Thin: the
 * turn loop, event→action mapping, and the deferred permission gate are all in
 * `turn-engine.ts` / `state/*` (pure, separately tested). The hook just holds
 * the session/abort/gate in refs and exposes imperative actions to the UI.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"

import { createAgentSession, type AgentSession } from "../../agent/session-runner"
import { createGateController, runTurn } from "./turn-engine"
import { DEFAULT_PERMISSION_CHOICES } from "../components/overlays/PermissionOverlay"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { ResolvedConfig } from "../../config/schema"
import type { Cell, PermissionMode, TuiAction } from "../state/types"

export type CreateSession = (params: { config: ResolvedConfig; sessionId?: string }) => AgentSession

export interface AgentSessionApi {
  send(prompt: string): Promise<void>
  abort(): void
  resolvePermission(decision: CapturePermissionDecision): void
  clear(newSessionId: string): Promise<void>
  resume(sessionId: string, cells: Cell[]): Promise<void>
  switchModel(model: string): Promise<void>
  switchMode(mode: PermissionMode): Promise<void>
  close(): Promise<void>
}

export function useAgentSession({
  config,
  dispatch,
  createSession = createAgentSession,
}: {
  config: ResolvedConfig
  dispatch: (action: TuiAction) => void
  createSession?: CreateSession
}): AgentSessionApi {
  const configRef = useRef(config)
  // Keep the latest config available to the async callbacks below without
  // reading/writing the ref during render (react-hooks/refs).
  useEffect(() => {
    configRef.current = config
  }, [config])
  const sessionRef = useRef<AgentSession | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const gate = useMemo(
    () =>
      createGateController((req) =>
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: { kind: "permission", req, choices: DEFAULT_PERMISSION_CHOICES, index: 0 },
        })
      ),
    [dispatch]
  )

  const ensureSession = useCallback((): AgentSession => {
    if (!sessionRef.current) {
      sessionRef.current = createSession({ config: configRef.current })
    }
    return sessionRef.current
  }, [createSession])

  const dropSession = useCallback(async () => {
    const current = sessionRef.current
    sessionRef.current = null
    if (current) await current.close()
  }, [])

  const send = useCallback(
    async (prompt: string) => {
      const session = ensureSession()
      const controller = new AbortController()
      abortRef.current = controller
      await runTurn({ session, prompt, dispatch, gate: gate.responder, signal: controller.signal })
      abortRef.current = null
    },
    [dispatch, ensureSession, gate]
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const resolvePermission = useCallback(
    (decision: CapturePermissionDecision) => {
      gate.resolve(decision)
      dispatch({ type: "OVERLAY_CLOSE" })
    },
    [dispatch, gate]
  )

  const clear = useCallback(
    async (newSessionId: string) => {
      await dropSession()
      dispatch({ type: "RESET", sessionId: newSessionId })
    },
    [dispatch, dropSession]
  )

  const resume = useCallback(
    async (sessionId: string, cells: Cell[]) => {
      await dropSession()
      // Adopt the prior session id so further turns append to its transcript;
      // its past cells are restored to the view (a fresh sidecar — model
      // context re-injection is the separate `resume` command's job).
      sessionRef.current = createSession({ config: configRef.current, sessionId })
      dispatch({ type: "RESET", sessionId })
      dispatch({ type: "LOAD_CELLS", cells })
    },
    [createSession, dispatch, dropSession]
  )

  const switchModel = useCallback(
    async (model: string) => {
      dispatch({ type: "SET_MODEL", model })
      // Options resolve lazily and are cached per session; recreate so the new
      // model takes effect on the next turn.
      await dropSession()
    },
    [dispatch, dropSession]
  )

  const switchMode = useCallback(
    async (mode: PermissionMode) => {
      dispatch({ type: "SET_MODE", mode })
      await dropSession()
    },
    [dispatch, dropSession]
  )

  const close = useCallback(async () => {
    await dropSession()
  }, [dropSession])

  return { send, abort, resolvePermission, clear, resume, switchModel, switchMode, close }
}
