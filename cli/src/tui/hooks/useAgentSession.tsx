/**
 * Owns the live `AgentSession` and drives turns from the React side. Thin: the
 * turn loop, event→action mapping, and the deferred permission gate are all in
 * `turn-engine.ts` / `state/*` (pure, separately tested). The hook just holds
 * the session/abort/gate in refs and exposes imperative actions to the UI.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"
import os from "node:os"

import { transport } from "@/lib/tauri"
import { compactSession } from "@/lib/claude/ipc"
import { WORKFLOW_COPILOT_ALLOWED_TOOLS } from "@/lib/claude/agents/workflow-copilot-prompt"

import { createAgentSession, type AgentSession } from "../../agent/session-runner"
import { runManualCompact } from "../../agent/manual-compact"
import { readToolApprovals } from "../../agent/tool-approvals"
import { resolveHome } from "../../config/load"
import { writeTranscript, type TranscriptEntry } from "../../agent/transcript"
import { SIDECAR_EVENT } from "../../runtime/protocol"
import { createHookRunner, type HookRunner } from "../runtime/hook-runner"
import { createCheckpointCapture, type CheckpointCapture } from "../runtime/checkpoint-capture"
import { realCheckpointFs } from "../runtime/checkpoint-store"
import { createGateController, runTurn } from "./turn-engine"
import { captureEventToActions } from "../state/event-mapper"
import { parseRateLimitHeaders } from "../format/rate-limits"
import { DEFAULT_PERMISSION_CHOICES } from "../components/overlays/PermissionOverlay"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { ResolvedConfig } from "../../config/schema"
import type { ThinkingLevel } from "../../config/schema"
import type { Cell, PermissionMode, TuiAction } from "../state/types"

export type CreateSession = (params: {
  config: ResolvedConfig
  sessionId?: string
  sessionKind?: import("@/lib/claude/types").SessionKind
}) => AgentSession

/** What a `/rewind` restores: the conversation, the files touched since the
 * checkpoint, or both. */
export type RewindScope = "conversation" | "files" | "both"

export interface AgentSessionApi {
  /** Stream one turn into the transcript. Resolves the captured reply (text +
   * usage) on success, or `null` when the turn errored. Plain chat ignores the
   * return; `/goal` + `/loop` feed it to their turn-drivers. */
  send(prompt: string): Promise<RunAndCaptureResult | null>
  abort(): void
  resolvePermission(decision: CapturePermissionDecision): void
  /** Add a tool to the live "Allow always" set so its subsequent requests are
   * auto-approved this session — no overlay, no waiting. Called when the user
   * picks "Allow always" so the same tool stops re-prompting mid-turn (the
   * persisted store is only re-read on session respawn). */
  rememberApproval(toolName: string): void
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
  /** List the rewind checkpoints captured this session (newest-first). */
  listCheckpoints(): {
    seq: number
    label: string
    ts: number
    cellCount: number
    fileCount: number
  }[]
  /** Restore a checkpoint by seq: files and/or conversation (`cells` = current). */
  rewind(seq: number, scope: RewindScope, cells: Cell[]): Promise<void>
  /** Enter Workflow Copilot mode: subsequent `send`s route to a dedicated
   * `workflow-editor`-kind session for `workflowId` (and its `wf_*` tools are
   * auto-approved). Idempotent. */
  enterCopilot(workflowId: string): void
  /** Leave copilot mode and tear down the copilot session. */
  exitCopilot(): Promise<void>
  close(): Promise<void>
}

/** Default checkpoint capture: real on-disk shadow store under `~/.cognia`. */
const defaultCreateCheckpoints = (getSessionId: () => string): CheckpointCapture =>
  createCheckpointCapture({
    home: resolveHome(process.env, os.homedir()),
    getSessionId,
    fs: realCheckpointFs,
    now: () => Date.now(),
  })

/** Rebuild transcript entries from the kept cells after a conversation rewind,
 * so the on-disk transcript matches the restored view. */
function cellsToEntries(cells: Cell[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const cell of cells) {
    if (cell.kind === "user") entries.push({ ts: 0, role: "user", content: cell.text })
    else if (cell.kind === "assistant")
      entries.push({ ts: 0, role: "assistant", content: cell.raw })
  }
  return entries
}

export function useAgentSession({
  config,
  dispatch,
  createSession = createAgentSession,
  subscribeSidecar = (handler) => transport.subscribe(SIDECAR_EVENT, handler),
  requestCompact = compactSession,
  createHooks = () =>
    createHookRunner({
      home: resolveHome(process.env, os.homedir()),
      osHome: os.homedir(),
      builtinHookOverrides: config.builtinHookOverrides,
    }),
  getCellCount = () => 0,
  createCheckpoints = defaultCreateCheckpoints,
  resolveApprovedTools,
}: {
  config: ResolvedConfig
  dispatch: (action: TuiAction) => void
  createSession?: CreateSession
  /** Subscribe to the sidecar event channel (injected for tests). */
  subscribeSidecar?: (handler: (payload: unknown) => void) => () => void
  /** Send the `claude_compact` control message (injected for tests). */
  requestCompact?: (sessionId: string, focus?: string) => Promise<void>
  /** Build the settings.json hook runner (injected for tests). */
  createHooks?: () => HookRunner
  /** Current committed cell count, read at each prompt boundary for `/rewind`. */
  getCellCount?: () => number
  /** Build the `/rewind` checkpoint capture (injected for tests). */
  createCheckpoints?: (getSessionId: () => string) => CheckpointCapture
  /** Resolve the persisted "Allow always" tool names to seed the live
   * auto-approve set. Defaults to the `tool-approvals.json` store (cwd-scoped);
   * injected in tests to stay off-disk. */
  resolveApprovedTools?: () => Set<string>
}): AgentSessionApi {
  const configRef = useRef(config)
  // Keep the latest config available to the async callbacks below without
  // reading/writing the ref during render (react-hooks/refs).
  useEffect(() => {
    configRef.current = config
  }, [config])
  const sessionRef = useRef<AgentSession | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The live "Allow always" set consulted by the gate's silent auto-approver.
  // Seeded from the persisted store and grown in place when the user picks
  // "Allow always", so an already-trusted tool stops re-prompting THIS session
  // (the persisted store is only re-read on a session respawn).
  const approvedToolsRef = useRef<Set<string>>(new Set())
  const cwd = config.cwd
  const seedApproved = useCallback(
    () =>
      resolveApprovedTools?.() ??
      readToolApprovals(resolveHome(process.env, os.homedir()), undefined, cwd),
    [resolveApprovedTools, cwd]
  )
  useEffect(() => {
    try {
      approvedToolsRef.current = new Set(seedApproved())
    } catch {
      approvedToolsRef.current = new Set()
    }
  }, [seedApproved])
  // Live API rate-limit headers: the sidecar's fetch-interceptor emits a
  // `usage_headers` message for every Anthropic response. Fold the
  // `anthropic-ratelimit-*` bag into a snapshot so the /limits panel + footer
  // can show real remaining-quota + reset countdowns (not just plan windows).
  // This subscription is independent of the turn loop, so it survives /clear and
  // /resume and updates whenever a response lands.
  useEffect(() => {
    const off = subscribeSidecar((payload) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { type?: unknown }).type !== "usage_headers"
      ) {
        return
      }
      const headers = (payload as { headers?: unknown }).headers
      if (!headers || typeof headers !== "object") return
      const snapshot = parseRateLimitHeaders(headers as Record<string, string>, Date.now())
      if (snapshot) dispatch({ type: "SET_RATE_LIMITS", snapshot })
    })
    return off
  }, [subscribeSidecar, dispatch])

  // The settings.json lifecycle-hook runner (loads the merged cognia + .claude
  // hook config once). Fired for each capture event + at turn end + on submit.
  const hookRunner = useMemo(() => createHooks(), [createHooks])
  // `/rewind` checkpoint capture — reads the live session id lazily so it tracks
  // /clear and /resume without being rebuilt.
  const getSessionId = useCallback(() => sessionRef.current?.sessionId ?? "", [])
  const checkpoint = useMemo(
    // getSessionId is invoked lazily by the checkpoint controller (on capture /
    // restore), never during render, so reading the ref here is safe.
    // eslint-disable-next-line react-hooks/refs
    () => createCheckpoints(getSessionId),
    [createCheckpoints, getSessionId]
  )

  const gate = useMemo(
    () =>
      createGateController(
        (req) =>
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: { kind: "permission", req, choices: DEFAULT_PERMISSION_CHOICES, index: 0 },
          }),
        // PreToolUse hooks: a deny blocks the tool before the overlay shows.
        (req) => hookRunner.preToolUse(req.toolName, req.input),
        // Silent auto-approve for tools the user already chose "Allow always".
        // The gate invokes this only when the model requests a tool mid-turn —
        // never during render — so reading the ref here is safe.
        // eslint-disable-next-line react-hooks/refs
        (req) => approvedToolsRef.current.has(req.toolName)
      ),
    [dispatch, hookRunner]
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

  // ── Workflow Copilot mode ──────────────────────────────────────────────────
  // A dedicated `workflow-editor`-kind session, isolated from the chat session
  // so the copilot's constrained prompt + tools never pollute normal chat. While
  // `copilotTargetRef` is set, `send` routes here.
  const copilotRef = useRef<AgentSession | null>(null)
  const copilotTargetRef = useRef<string | null>(null)

  const ensureCopilotSession = useCallback(
    (workflowId: string): AgentSession => {
      if (!copilotRef.current) {
        copilotRef.current = createSession({
          // `pluginTools` forces the in-tree plugin runtime to load so the
          // workflow-ai `wf_*` tools surface; `workflow:<id>` lets build-options
          // derive the workflow id + inject the live editor-store snapshot.
          config: { ...configRef.current, pluginTools: true },
          sessionId: `workflow:${workflowId}`,
          sessionKind: "workflow-editor",
        })
      }
      return copilotRef.current
    },
    [createSession]
  )

  const dropCopilotSession = useCallback(async () => {
    const current = copilotRef.current
    copilotRef.current = null
    if (current) await current.close()
  }, [])

  const enterCopilot = useCallback((workflowId: string) => {
    copilotTargetRef.current = workflowId
    // Auto-approve the copilot's whole (read/propose-only) toolset so wf_* calls
    // never pop a permission overlay — the real consent is the Apply step.
    for (const t of WORKFLOW_COPILOT_ALLOWED_TOOLS) approvedToolsRef.current.add(t)
  }, [])

  const exitCopilot = useCallback(async () => {
    copilotTargetRef.current = null
    await dropCopilotSession()
  }, [dropCopilotSession])

  const send = useCallback(
    async (prompt: string) => {
      // In copilot mode the turn runs on the dedicated workflow-editor session.
      const copilotTarget = copilotTargetRef.current
      const session = copilotTarget ? ensureCopilotSession(copilotTarget) : ensureSession()
      // Fire UserPromptSubmit hooks before the turn (observational here).
      hookRunner.onPrompt(prompt)
      // Open a rewind checkpoint for this turn (cellCount = state before it ran).
      checkpoint.beginTurn(getCellCount(), prompt)
      const controller = new AbortController()
      abortRef.current = controller
      const { ok, result } = await runTurn({
        session,
        prompt,
        dispatch,
        gate: gate.responder,
        signal: controller.signal,
        hooks: hookRunner,
        onToolCall: (toolName, input) => checkpoint.onToolCall(toolName, input),
      })
      abortRef.current = null
      // When the turn errored (timeout, sidecar crash, send-failed), the session
      // is stale — the sidecar may still be running the previous turn, and the
      // gate queue may hold an orphaned resolver. Drop both so the next message
      // starts fresh instead of cascading into a permanent hang.
      if (!ok) {
        gate.reset()
        if (copilotTarget) await dropCopilotSession()
        else await dropSession()
        return null
      }
      // Hand the captured reply (text + usage) back so a self-driving caller
      // (`/goal`, `/loop`) can feed it to a turn-driver. Plain chat ignores it.
      return result ?? null
    },
    [
      dispatch,
      ensureSession,
      ensureCopilotSession,
      gate,
      dropSession,
      dropCopilotSession,
      hookRunner,
      checkpoint,
      getCellCount,
    ]
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

  const rememberApproval = useCallback((toolName: string) => {
    approvedToolsRef.current.add(toolName)
  }, [])

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

  const listCheckpoints = useCallback(
    () =>
      checkpoint.list().map((cp) => ({
        seq: cp.seq,
        label: cp.label,
        ts: cp.ts,
        cellCount: cp.cellCount,
        fileCount: cp.files.length,
      })),
    [checkpoint]
  )

  const rewind = useCallback(
    async (seq: number, scope: RewindScope, cells: Cell[]) => {
      const cp = checkpoint.list().find((c) => c.seq === seq)
      if (!cp) {
        dispatch({ type: "NOTICE", message: `Checkpoint #${seq} not found.` })
        return
      }
      if (scope === "files" || scope === "both") {
        checkpoint.store.restore(cp, { files: true, conversation: false })
      }
      if (scope === "conversation" || scope === "both") {
        const kept = cells.slice(0, cp.cellCount)
        const sid = sessionRef.current?.sessionId
        if (sid) {
          // Rebuild the on-disk transcript to match the restored view, then
          // re-mint a fresh session adopting the same id (the model forgets the
          // rewound turns; further turns append to the truncated transcript).
          writeTranscript(resolveHome(process.env, os.homedir()), sid, cellsToEntries(kept))
          await dropSession()
          sessionRef.current = createSession({ config: configRef.current, sessionId: sid })
          dispatch({ type: "RESET", sessionId: sid })
          dispatch({ type: "LOAD_CELLS", cells: kept })
        }
      }
      dispatch({
        type: "NOTICE",
        message: `Rewound to checkpoint #${seq} (${scope}) — ${cp.label}.`,
      })
    },
    [checkpoint, createSession, dispatch, dropSession]
  )

  const close = useCallback(async () => {
    await dropSession()
    await dropCopilotSession()
  }, [dropSession, dropCopilotSession])

  return {
    send,
    abort,
    resolvePermission,
    rememberApproval,
    clear,
    resume,
    switchModel,
    switchMode,
    switchThinking,
    switchProvider,
    invalidate,
    compact,
    listCheckpoints,
    rewind,
    enterCopilot,
    exitCopilot,
    close,
  }
}
