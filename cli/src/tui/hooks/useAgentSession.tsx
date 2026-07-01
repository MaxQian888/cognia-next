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
  /** Switch the active agent mode (built-in or custom). The mode's prompt /
   * tools / model / permission fold deep into resolved SendOptions, so the
   * session is recreated to take effect on the next turn. */
  switchAgentMode(modeId: string): Promise<void>
  /** Switch the session working directory (`/cd`). Like the model, the cwd folds
   * deep into resolved SendOptions and drives the sidecar respawn, so the live
   * session is dropped and recreated under the new cwd on the next turn. */
  changeCwd(dir: string): Promise<void>
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
  /** Truncate the conversation to the first `cellCount` cells (drop the rest),
   * re-minting the session under the same id. Drives edit-and-fork. Files are
   * not reverted. No-op without an active session. */
  forkConversationAt(cellCount: number, cells: Cell[]): Promise<void>
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
  sessionId,
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
  /** The app's current session id (from mount / `/clear` / `/resume`). The
   * lazily-created chat session is bound to it so its on-disk transcript lands
   * under the SAME id `/export`, `/handoff`, `/resume`, and the checkpoint store
   * read from. Without this the runner would mint its own divergent id and
   * `/export` would always report "no turns". */
  sessionId?: string
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
  // The live app session id, mirrored into a ref so `ensureSession` binds the
  // lazily-created session to it (and tracks `/clear`/`/resume` id changes)
  // without recreating the callback on every id change.
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
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
  //
  // `createHooks` is a destructuring default recreated on EVERY render when the
  // caller doesn't inject one. Memoizing the runner on that churning identity
  // rebuilt it — re-reading the hooks config off disk — every render, and far
  // worse gave `gate` below a fresh instance each render: a permission responder
  // pushed its resolver into the OLD gate's queue, the `OVERLAY_OPEN` dispatch
  // re-rendered and swapped in a NEW empty-queued gate, and the user's approval
  // then resolved nothing — hanging every write/edit/exec turn while read-only
  // tools (which never round-trip the gate) kept working. Pin the factory to its
  // real input so the runner — and therefore the gate's pending-approval queue —
  // survive re-renders.
  const stableCreateHooks = useMemo(
    () => createHooks,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.builtinHookOverrides]
  )
  const hookRunner = useMemo(() => stableCreateHooks(), [stableCreateHooks])
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
      // Bind the session to the app's id (when known) so its transcript file is
      // the one `/export`, `/handoff`, and `/resume` read back. Omitting it let
      // the runner mint a divergent id — `/export` then found no file ("no
      // turns"). The ref is read lazily on creation (never during render), so it
      // reflects the latest `/clear`/`/resume` id.

      const boundId = sessionIdRef.current
      sessionRef.current = createSession({
        config: configRef.current,
        ...(boundId ? { sessionId: boundId } : {}),
      })
    }
    return sessionRef.current
  }, [createSession])

  const dropSession = useCallback(async () => {
    // Abort any in-flight turn FIRST. /clear, /resume, fork, and model/provider/
    // thinking/agent-mode switches all funnel through here and can fire mid-turn
    // (slash commands bypass the busy gate). Killing the sidecar from under a live
    // capture would reject it as a non-abort error → a stray "error" cell landing
    // in the freshly-RESET session. Aborting first routes it through the clean
    // (recoverable) interrupt path before the reset wipes the old cells.
    abortRef.current?.abort()
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
    // Same rationale as dropSession: abort a live copilot turn before tearing the
    // session down (both turn kinds share `abortRef`).
    abortRef.current?.abort()
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
      const { ok, result, recoverable } = await runTurn({
        session,
        prompt,
        dispatch,
        gate: gate.responder,
        signal: controller.signal,
        // Interactive turns impose NO wall-clock cap. A live agentic turn can
        // legitimately run for many minutes (long thinking, many tool legs) and
        // must not be killed mid-progress. The idle watchdog
        // (`streamIdleTimeoutMs`, paused during tool exec / approvals) catches a
        // genuinely stalled provider stream, and the per-tool execution deadline
        // (`toolExecutionTimeoutMs`) catches a hung tool — together they bound
        // the turn without the 5-minute wall-clock that `run-and-capture`
        // defaults to for headless/connector runs. `0` disables that wall-clock.
        timeoutMs: 0,
        hooks: hookRunner,
        onToolCall: (toolName, input) => checkpoint.onToolCall(toolName, input),
        showActiveSkills: configRef.current.showActiveSkills,
      })
      abortRef.current = null
      if (!ok) {
        // Always clear any orphaned gate resolver from the failed turn.
        gate.reset()
        // Only drop the session when it's genuinely unusable (dead sidecar /
        // unknown fault). A timeout, idle stall, provider error or user
        // interrupt leaves the multi-turn session alive WITH its accumulated
        // context, so keep it — the next message continues the conversation
        // instead of silently restarting from an empty history.
        if (!recoverable) {
          if (copilotTarget) await dropCopilotSession()
          else await dropSession()
        }
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
      // `gate.resolve` re-opens the overlay (via the `onRequest` dispatch) for the
      // next queued request when a batch of parallel tool calls is awaiting
      // approval. Only close the overlay once the queue has fully drained —
      // closing unconditionally would hide the next ask and hang those tools.
      if (!gate.isPending()) dispatch({ type: "OVERLAY_CLOSE" })
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

  const changeCwd = useCallback(
    async (dir: string) => {
      dispatch({ type: "SET_CWD", cwd: dir })
      // The cwd is baked into the captured SendOptions of a live session (and the
      // sidecar spawned under it); only a fresh session picks up the new dir. Drop
      // it so the next turn recreates from the updated config — same contract as
      // switchModel. configRef is refreshed by the SET_CWD re-render before then.
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

  const switchAgentMode = useCallback(
    async (modeId: string) => {
      dispatch({ type: "SET_AGENT_MODE", modeId })
      // A mode folds into resolved SendOptions (system prompt append, tool
      // allow-list, model override, permission ruleset) — all resolved lazily
      // and cached per session. Recreate so the switch takes effect next turn.
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

  /**
   * Truncate the conversation to its first `cellCount` cells: rebuild the
   * on-disk transcript, re-mint a fresh session under the same id (so the model
   * forgets the dropped turns), and reload the kept cells into the view. Shared
   * by `/rewind` (conversation scope) and the edit-and-fork flow. Files are NOT
   * reverted — that's the caller's `scope` decision. No-op without a session id.
   */
  const forkConversationAt = useCallback(
    async (cellCount: number, cells: Cell[]) => {
      const sid = sessionRef.current?.sessionId
      if (!sid) return
      const kept = cells.slice(0, cellCount)
      writeTranscript(resolveHome(process.env, os.homedir()), sid, cellsToEntries(kept))
      await dropSession()
      sessionRef.current = createSession({ config: configRef.current, sessionId: sid })
      dispatch({ type: "RESET", sessionId: sid })
      dispatch({ type: "LOAD_CELLS", cells: kept })
    },
    [createSession, dispatch, dropSession]
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
        await forkConversationAt(cp.cellCount, cells)
      }
      dispatch({
        type: "NOTICE",
        message: `Rewound to checkpoint #${seq} (${scope}) — ${cp.label}.`,
      })
    },
    [checkpoint, dispatch, forkConversationAt]
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
    switchAgentMode,
    changeCwd,
    invalidate,
    compact,
    listCheckpoints,
    rewind,
    forkConversationAt,
    enterCopilot,
    exitCopilot,
    close,
  }
}
