/**
 * Owns the live `AgentSession` and drives turns from the React side. Thin: the
 * turn loop, event→action mapping, and the deferred permission gate are all in
 * `turn-engine.ts` / `state/*` (pure, separately tested). The hook just holds
 * the session/abort/gate in refs and exposes imperative actions to the UI.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"

import { transport } from "@/lib/tauri"
import { compactSession } from "@/lib/claude/ipc"

import { createAgentSession, type AgentSession } from "../../agent/session-runner"
import { runManualCompact } from "../../agent/manual-compact"
import { SIDECAR_EVENT } from "../../runtime/protocol"
import { createGateController, runTurn } from "./turn-engine"
import { captureEventToActions } from "../state/event-mapper"
import { DEFAULT_PERMISSION_CHOICES } from "../components/overlays/PermissionOverlay"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { ResolvedConfig } from "../../config/schema"
import type { ThinkingLevel } from "../../config/schema"
import type { Cell, PermissionMode, TuiAction } from "../state/types"

export type CreateSession = (params: { config: ResolvedConfig; sessionId?: string }) => AgentSession

export interface AgentSessionApi {
  /** Stream one turn into the transcript. Resolves the captured reply (text +
   * usage) on success, or `null` when the turn errored. Plain chat ignores the
   * return; `/goal` + `/loop` feed it to their turn-drivers. */
  send(prompt: string): Promise<RunAndCaptureResult | null>
  abort(): void
  resolvePermission(decision: CapturePermissionDecision): void
  clear(newSessionId: string): Promise<void>
  resume(sessionId: string, cells: Cell[]): Promise<void>
  switchModel(model: string): Promise<void>
  switchMode(mode: PermissionMode): Promise<void>
  switchThinking(level: ThinkingLevel, pluginTools?: boolean): Promise<void>
  switchProvider(provider: string, model?: string): Promise<void>
  /** Re-resolve SendOptions on the next turn (after an MCP/skill/plugin toggle)
   * without respawning the sidecar. No-op when no session is live yet. */
  invalidate(): void
  /** Manually compact the live session's context (`/compact`), both dispatch
   * paths. No-op (with a notice) until a turn has spawned the sidecar. */
  compact(focus?: string): Promise<void>
  close(): Promise<void>
}

export function useAgentSession({
  config,
  dispatch,
  createSession = createAgentSession,
  subscribeSidecar = (handler) => transport.subscribe(SIDECAR_EVENT, handler),
  requestCompact = compactSession,
}: {
  config: ResolvedConfig
  dispatch: (action: TuiAction) => void
  createSession?: CreateSession
  /** Subscribe to the sidecar event channel (injected for tests). */
  subscribeSidecar?: (handler: (payload: unknown) => void) => () => void
  /** Send the `claude_compact` control message (injected for tests). */
  requestCompact?: (sessionId: string, focus?: string) => Promise<void>
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
      const { ok, result } = await runTurn({
        session,
        prompt,
        dispatch,
        gate: gate.responder,
        signal: controller.signal,
      })
      abortRef.current = null
      // When the turn errored (timeout, sidecar crash, send-failed), the session
      // is stale — the sidecar may still be running the previous turn, and the
      // gate queue may hold an orphaned resolver. Drop both so the next message
      // starts fresh instead of cascading into a permanent hang.
      if (!ok) {
        gate.reset()
        await dropSession()
        return null
      }
      // Hand the captured reply (text + usage) back so a self-driving caller
      // (`/goal`, `/loop`) can feed it to a turn-driver. Plain chat ignores it.
      return result ?? null
    },
    [dispatch, ensureSession, gate, dropSession]
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
      // Unlike model/thinking (folded deep into resolved SendOptions), the
      // permission mode can be mutated on a LIVE session in place — the sidecar
      // calls `Query.setPermissionMode` (Anthropic) / re-reads the mutated
      // `sendOptions` (ai-sdk). So we do NOT drop the session: the in-process
      // conversation is preserved across a Shift+Tab / plan-approval switch
      // (the old respawn lost it, contextless-implementing an "approved" plan).
      // Before a session is live there is nothing to mutate — SET_MODE folds
      // into the first `startSession`'s options.
      const session = sessionRef.current
      if (session?.isLive?.() && session.setPermissionMode) {
        await session.setPermissionMode(mode)
      }
    },
    [dispatch]
  )

  const switchThinking = useCallback(
    async (level: ThinkingLevel, pluginTools?: boolean) => {
      // `pluginTools` rides along for the `"ultracode"` tier (couples the
      // dynamic-workflow plugin tools); omitted ⇒ the reducer leaves it alone.
      dispatch({
        type: "SET_THINKING",
        level,
        ...(pluginTools !== undefined ? { pluginTools } : {}),
      })
      // Effort + pluginTools are folded into SendOptions, which resolve lazily
      // and are cached per session — recreate so the change takes effect next turn.
      await dropSession()
    },
    [dispatch, dropSession]
  )

  const switchProvider = useCallback(
    async (provider: string, model?: string) => {
      dispatch({ type: "SET_PROVIDER", provider })
      // Reset the active model to the new provider's default so a stale model id
      // from the previous provider can't be sent to one that won't serve it.
      if (model) dispatch({ type: "SET_MODEL", model })
      // The provider determines the dispatch path + auth env, both resolved
      // lazily per session — recreate so the switch takes effect next turn.
      await dropSession()
    },
    [dispatch, dropSession]
  )

  const invalidate = useCallback(() => {
    sessionRef.current?.invalidateOptions?.()
  }, [])

  const compact = useCallback(
    async (focus?: string) => {
      const session = sessionRef.current
      // Manual compaction targets a session the sidecar already knows by id —
      // i.e. one that has spawned (≥1 turn). Before that there is nothing to
      // compact, so guide the user instead of sending a control message for an
      // unknown session.
      if (!session?.isLive?.()) {
        dispatch({ type: "NOTICE", message: "Nothing to compact yet — send a message first." })
        return
      }
      await runManualCompact({
        sessionId: session.sessionId,
        focus,
        subscribe: subscribeSidecar,
        compact: requestCompact,
        // Reuse the capture→reducer mapping so the boundary renders exactly like
        // an in-turn (auto) compaction.
        emit: (event) => {
          for (const action of captureEventToActions(event)) dispatch(action)
        },
        onNotice: (message) => dispatch({ type: "NOTICE", message }),
      })
    },
    [dispatch, requestCompact, subscribeSidecar]
  )

  const close = useCallback(async () => {
    await dropSession()
  }, [dropSession])

  return {
    send,
    abort,
    resolvePermission,
    clear,
    resume,
    switchModel,
    switchMode,
    switchThinking,
    switchProvider,
    invalidate,
    compact,
    close,
  }
}
