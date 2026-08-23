/**
 * Root of the interactive TUI. Owns the reducer + agent session, routes slash
 * commands, handles global keys (Ctrl+C exit, Esc interrupt/cancel), and lays
 * out the transcript, the in-flight region, overlays, and the composer.
 *
 * Collaborators (session factory, handoff push, exit, clock) are injected so the
 * component tests drive it without a live sidecar.
 */
import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { randomUUID } from "node:crypto"
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useApp, useBoxMetrics, useStdout, type DOMElement } from "ink"
import cliHostStateMessages from "@/i18n/messages/en/cliHostState.json"
import { createMessageResolver } from "@/lib/headless/i18n"

import { Banner } from "./Banner"
import { useScroll } from "../hooks/useScroll"
import { useTranscriptCursor } from "../hooks/useTranscriptCursor"
import { resolveLayoutMode, readLayoutCapability, type LayoutCapability } from "../layout-mode"
import { type ScreenStream } from "../screen"
import { type TitleStream, type TitleEnv } from "../terminal-title"
import { ThemeProvider } from "../theme/context"
import { RenderPrefsProvider } from "../render/context"
import { resolveTheme } from "../theme/resolve"
import { StartupGate } from "./StartupGate"
import { BackendConnect } from "./BackendConnect"
import { BackendFailure, type BackendFailureAction } from "./BackendFailure"
import { BackendInstall } from "./BackendInstall"
import type { BackendInstallOption } from "../state/types"
import { createAgentSession, type AgentSession } from "../../agent/session-runner"
import {
  externalCapabilities,
  isBuiltinBackend,
  supportsFeature,
  unsupportedFeatureMessage,
} from "../runtime/backend-capabilities"
import {
  defaultBackendModelHost,
  formatExternalModelLabel,
  type ExternalModelOption,
} from "../runtime/backend-models"
import { disconnectBackend } from "../runtime/backend-controller"
import { LaunchShell } from "./LaunchShell"
import { LAUNCH_LIST_CHROME_ROWS, launchListRows, launchShellLayout } from "./launch-shell-layout"
import { createBackendLifecycle, type BackendLifecycle } from "../runtime/backend-lifecycle"
import type {
  connectBackend,
  BackendConnection,
  BackendConnectFailure,
} from "../runtime/backend-controller"
import type { RunInstallResult, InstallMethod } from "../runtime/backend-install"
import { backendIdentity, backendModelMetaTarget } from "../runtime/backend-identity"
import type { ListDirs } from "./FolderPicker"
import { trustFolder as defaultTrustFolder } from "../../config/trusted-folders"
import { listSessions, type ReadDir } from "./sessions-list"
import { recomputeSubagentModelRows } from "../runtime/subagent-models-model"
import { useAskUserOverlay } from "../hooks/use-ask-user-overlay"
import { savePlan } from "../runtime/plan-store"
import {
  planFileName,
  planTitle,
  planDecisionMode,
  PLAN_APPROVED_PROMPT,
  PLAN_EXECUTE_PROMPT,
  type PlanDecision,
} from "../runtime/plan"
import { collectModelOptions } from "./model-options"
import { dispatchCommand } from "../commands/dispatch"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { preprocessMentions } from "../mention/preprocess"
import { skillSetEnabled } from "../runtime/skill-controller"
import { mcpAuthStartupNotices } from "../runtime/mcp-controller"
import { createMcpProbeCache } from "../runtime/mcp-cache"
import {
  readEnabled as readEnabledSkills,
  setEnabled as setSkillEnabled,
} from "../../skill/skill-state"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { buildAgents, discoverAgentFiles } from "../../agent/discover-agents"
import { parseBang } from "../commands/bash-shellout"

const resolveHostStateMessage = createMessageResolver(cliHostStateMessages)
import { parseHashMemory } from "../input/hash-memory"
import {
  runInteractiveShell as defaultRunInteractiveShell,
  runShell as defaultRunShell,
  type RunInteractiveShellOpts,
  type ShellResult,
  type RunShellOpts,
} from "../../agent/run-shell"
import { registerFeatureCommands } from "../commands"
import { runGoalStreaming } from "../runtime/goal-run"
import { runLoopStreaming } from "../runtime/loop-run"
import { runFixStreaming } from "../runtime/fix-run"
import { frameSteer } from "../runtime/driven-turns"
import { copilotCheckProposal } from "../runtime/workflow-copilot-controller"
import { resolveModelMeta, type ModelMeta } from "../runtime/model-meta"
import { initOpenRouterCatalog as defaultInitOpenRouterCatalog } from "../runtime/openrouter-catalog-controller"
import { registerCustomCommands as defaultRegisterCustomCommands } from "../commands/custom-commands"
import { shouldAutoCompact } from "../../agent/auto-compact"
import { ensureCliDb } from "../../db/bootstrap"
import { formSubmit } from "../state/form"
import { createInitialState } from "../state/initial"
import { requiresAcknowledgement } from "../state/permission-mode-meta"
import { startupBypassConfirmOverlay } from "../runtime/permission-mode-switch"
import { tuiReducer } from "../state/reducer"
import { isBusy } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { runningSubagents } from "../format/subagent"
import type { StatusSegmentView } from "../format/status-bar"
import {
  countInterruptedCliBackgroundRuns,
  countRunningCliBackgroundRuns,
} from "../../agent/subagent-background-tasks"
import { copyToClipboard, clipboardFailureMessage, type CopyResult } from "../clipboard"
import { readClipboardImage as defaultReadClipboardImage } from "../clipboard-image"
import { searchHistory } from "../input/history-search"
import { bufferText, insertText } from "../input/buffer"
import { appendHistory } from "../input/history-store"
import { useAgentSession, type AgentSessionApi, type CreateSession } from "../hooks/useAgentSession"
import { useLogIngest } from "../hooks/use-log-ingest"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { terminalLayout } from "../layout/terminal-layout"
import { addToolApproval, readToolApprovals } from "../../agent/tool-approvals"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import { mintSessionId } from "../../agent/run"
import { readTranscript, type TranscriptFs } from "../../agent/transcript"
import { resolveHome } from "../../config/load"
import { setCredential, type CredentialKind } from "../../config/credentials"
import {
  setConfigValue,
  setAgentBackendModel,
  setProviderModel,
  setStatusBarConfig,
  setMascotConfig,
  setPluginToolsConfig,
  setBuiltinTools,
  setBooleanFlag,
  setBuiltinHookOverride,
  setRenderConfig,
  setNumberConfig,
  setClipboardConfig,
  setGitWorkflowConfig,
  setLoggingConfig,
  setSubagentModel,
  setEditorConfig,
} from "../../config/mutate"
import { openInEditor, detectEditor } from "../runtime/editor"
import { resolveKeybindings } from "../input/keybindings"
import { collectProviderOptions } from "../commands/provider-options"
import {
  DEFAULT_MOUSE_MODE,
  DEFAULT_SELECTION_MODE,
  resolveGitWorkflowConfig,
  resolveRenderConfig,
  resolveNotices,
  type SubagentModelOverride,
} from "../../config/schema"
import { VERSION } from "../../version"
import {
  settingsSections,
  NUMERIC_RENDER_KEYS,
  type SettingsRow,
  type SettingsApplyTarget,
} from "../runtime/settings-sections"
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"
import type { ListDir } from "../commands/file-completer"
import type {
  ResolvedConfig,
  StatusBarConfig,
  MascotConfig,
  ClipboardConfig,
  EditorConfig,
  OutputStyle,
  StatusTheme,
  MascotStyle,
  CliLoggingConfig,
} from "../../config/schema"
import { clearTerminal, readThemeFile } from "./app/app-helpers"
import { useBashShellout } from "./app/use-bash-shellout"
import { useBacktrack } from "./app/use-backtrack"
import { useSteerQueue } from "./app/use-steer-queue"
import { useTerminalChrome } from "./app/use-terminal-chrome"
import { useTextSelection } from "../hooks/use-text-selection"
import type { FrameBuffer } from "../selection/frame-buffer"
import { TranscriptRegion } from "./app/TranscriptRegion"
import { AppOverlays } from "./app/AppOverlays"
import { BottomRegion } from "./app/BottomRegion"
import {
  createTuiInlineComplete,
  isAiSuggestEnabled,
  isLocalSuggestEnabled,
} from "../input/ai-complete"
import { TuiViewportFrame } from "./app/TuiViewportFrame"
import type { AgentTreeHit } from "./BottomStatus"
import { useGlobalKeys } from "./app/use-global-keys"
import { useApplyEffect } from "./app/use-apply-effect"
import {
  attachLocalHost,
  attachedHostStatus,
  detachLocalHost,
  flushAttachedHostStateOutbox,
  queueAttachedHostStateAction,
  readAttachedHostStateOutbox,
  readAttachedHost,
  type AttachedHostConnection,
} from "../../handoff/host-state-client"
import { canonicalEnvelopeToActions } from "../state/event-mapper"
import type { AllowedHostStateIntent } from "@cognia/agent-config-types/host-state"

// Register the feature-command clusters (Cognia runtime, MCP, plugins, skills)
// on top of the core catalog. Idempotent — safe at module load.
registerFeatureCommands()

export type InstallOptionResolver = (
  failure: BackendConnectFailure
) => Promise<BackendInstallOption | null>

export type InstallRunner = (deps: {
  method: InstallMethod
  onLine: (line: string) => void
  signal?: AbortSignal
}) => Promise<RunInstallResult>

/**
 * Resolve the installable fix for a failed connect, or `null`. Only a missing
 * binary (`command` failure) has one, and only when an officially-supported
 * method's prerequisites are present here — so a curl installer is never offered
 * without `curl`, nor an npm install without `npm`. Lazy-imports the install
 * stack so a built-in session never parses it.
 */
async function defaultResolveInstallOption(
  failure: BackendConnectFailure
): Promise<BackendInstallOption | null> {
  if (failure.kind !== "command" || !failure.command) return null
  const [{ resolveInstallPlan, pickInstallMethod }, { commandExists }] = await Promise.all([
    import("../runtime/backend-install"),
    import("../../runtime/external/node-backend"),
  ])
  const plan = resolveInstallPlan(failure.command)
  if (!plan) return null
  const method = await pickInstallMethod(plan, commandExists)
  if (!method) return null
  return { command: failure.command, name: plan.name, method }
}

/** Run an install method, streaming its output. Lazy-imported so only the
 * install path pays for it. Injected in tests so nothing is spawned. */
async function defaultRunInstall(deps: {
  method: InstallMethod
  onLine: (line: string) => void
  signal?: AbortSignal
}): Promise<RunInstallResult> {
  const { runInstall } = await import("../runtime/backend-install")
  return runInstall(deps)
}

export interface AppProps {
  config: ResolvedConfig
  sessionId: string
  createSession?: CreateSession
  /**
   * Factory for a session that runs on an external agent. Kept separate from
   * `createSession` because the active backend is now switchable at runtime
   * (`/backend`), so the App — not the launcher — has to pick between them, and
   * has to hand the external one the connection made during startup so the turn
   * reuses that process instead of spawning a second.
   */
  createExternalSession?: (params: {
    config: ResolvedConfig
    sessionId?: string
    connection?: {
      agentId: string
      presetId: string
      capabilities?: { negotiated?: import("@/types/agent/external-agent").AcpCapabilities }
    }
    onToolHostStatus?: (snapshot: import("../../agent/tool-host/status").ToolHostSnapshot) => void
  }) => AgentSession
  /** Bring the external backend up. Injected so tests never spawn a process. */
  connectBackendFn?: typeof connectBackend
  /** Resolve the installable fix for a missing-command failure. Injected so
   * tests never probe the real filesystem for package managers. */
  resolveInstallOptionFn?: InstallOptionResolver
  /** Run the chosen install method. Injected so tests never spawn an installer. */
  runInstallFn?: InstallRunner
  pushHandoff?: (sessionId: string) => boolean | Promise<boolean>
  /** Override the exit + clock for tests. */
  onExit?: () => void
  now?: () => number
  mintId?: () => string
  /** Directory lister for `@` completion; defaults to the real filesystem. */
  listDir?: ListDir
  /** Config home (`~/.cognia`); defaults to the resolved home. */
  home?: string
  /** OS home (`~`); defaults to `os.homedir()`. Threaded to the `/skill`
   * controller so it can reuse Claude Code (`~/.claude/skills`) + Codex
   * (`~/.agents/skills`) skill dirs. */
  osHome?: string
  /** Session-directory reader for `/sessions`; defaults to the real filesystem. */
  readdir?: ReadDir
  /** Transcript reader for `/sessions` + resume; defaults to the real filesystem. */
  transcriptFs?: TranscriptFs
  /** Clipboard writer for `/copy`; defaults to the OS clipboard helper. */
  copyClipboard?: (text: string) => Promise<CopyResult>
  /** Terminal wiper for `/clear`; defaults to the ANSI clear-screen sequence. */
  clearScreen?: () => void
  /**
   * Persist a top-level config key to `~/.cognia/config.json` when changed from
   * the `/config` panel; defaults to the real config writer. Returns false on
   * failure so the App can surface a notice without throwing.
   */
  persistConfig?: (key: string, value: string) => boolean
  /**
   * Remember a model for a specific provider in `~/.cognia/config.json`
   * (`providers[id].model`) when picked from `/model`; defaults to the real
   * per-provider writer. Returns false on failure so the App can surface a
   * notice without throwing.
   */
  persistProviderModel?: (providerId: string, modelId: string) => boolean
  /** Test seam for the per-backend model writer (`agentBackends[presetId]`). */
  persistBackendModel?: (presetId: string, modelId: string) => boolean
  /** Test seam for the external agent's own model catalog (`model/list`). */
  listExternalModels?: (agentId: string) => Promise<ExternalModelOption[]>
  /**
   * Persist a freshly-entered provider credential to
   * `~/.cognia/credentials.json` (0600) when the `/provider` key prompt is
   * submitted; defaults to the real {@link setCredential} writer. Returns false
   * on failure (read-only home) so the prompt can surface the error inline.
   */
  persistCredential?: (providerId: string, secret: string, kind: CredentialKind) => boolean
  /**
   * Flush the CLI-local Dexie after a runtime feature writes to it; defaults to
   * scheduling a debounced snapshot. Injected as a no-op by tests so they never
   * touch the real `~/.cognia/db.json`.
   */
  persistDb?: () => void
  /** Run a `!command` shell-out; defaults to the real local shell. */
  runShell?: (command: string, opts: RunShellOpts) => Promise<ShellResult>
  /** Run an interactive `!command` with inherited terminal I/O while Ink is
   * suspended. Injected in tests so no full-screen child process is launched. */
  runInteractiveShell?: (command: string, opts: RunInteractiveShellOpts) => Promise<ShellResult>
  /** Persist an "Allow always" tool choice; defaults to the real
   * `tool-approvals.json` writer. Injected as a no-op by tests. */
  persistToolApproval?: (home: string, toolName: string) => void
  /**
   * Whether `config.cwd` is already trusted. `false` opens the app in the
   * startup phase (welcome banner + "do you trust this folder?" gate). Defaults
   * to `true` so tests render straight into chat; `mount.tsx` passes the real
   * trust-store result. */
  trusted?: boolean
  /** Persist a folder as trusted; defaults to the real trusted-folders writer. */
  trustFolderFn?: (home: string, cwd: string) => void
  /** Dirs-only lister for the startup folder picker; defaults to the real fs. */
  listDirs?: ListDirs
  /** Persist a `/statusbar` change to config.json; defaults to the real writer. */
  persistStatusBar?: (home: string, patch: StatusBarConfig) => void
  /** Persist a `/mascot` change to config.json; defaults to the real writer. */
  persistMascot?: (home: string, patch: MascotConfig) => void
  /** Persist a `/editor <command>` change to config.json; defaults to the real writer. */
  persistEditor?: (home: string, patch: EditorConfig) => void
  /** Spawn the editor for `/open`; defaults to the real `openInEditor` (injected
   * in tests so they never launch a real editor). */
  openInEditorFn?: typeof openInEditor
  /** Read a persisted plan file back (for fresh-session execution after an
   * "Edit plan first"); defaults to a best-effort fs read. Injected in tests. */
  loadPlanFile?: (file: string) => string | null
  /** Persist the `pluginTools` gate (toggled by the effort slider's `ultracode`
   * tier) to config.json; defaults to the real writer. Injected as a no-op by
   * tests so they never touch the real `~/.cognia/config.json`. */
  persistPluginTools?: (home: string, enabled: boolean) => void
  /** Composer history to seed (oldest → newest); defaults to none. `mount.tsx`
   * passes the persisted `~/.cognia/history.json`. */
  initialHistory?: string[]
  /** Slash command to run once on mount, after the trust gate clears — the
   * `--continue` / `--resume` launch flags (`/continue`, `/resume [id]`). */
  initialCommand?: string
  /** Permission mode supplied as a launch-only CLI overlay; never persist it. */
  sessionOnlyPermissionMode?: ResolvedConfig["permissionMode"]
  /** Persist a newly-submitted composer line to the history store; defaults to
   * the real appender. Injected as a no-op by tests. */
  persistHistory?: (entry: string) => void
  /** Resolve the active model's context window + pricing from the catalog;
   * defaults to the real models.dev reader. Injected by tests so they don't
   * touch the catalog and the async dispatch stays deterministic. */
  resolveMeta?: (provider: string, model: string | undefined) => Promise<ModelMeta>
  /** Prime + (if stale) refresh the OpenRouter live-models catalog at boot, so
   * the `/model` picker reflects the synced real-time list. Defaults to the real
   * controller; injected as a no-op by tests so they don't open the db / network. */
  initOpenRouterCatalog?: (opts?: { apiKey?: string }) => Promise<void>
  /** Discover + register `.claude/commands` / `.cognia/commands` prompt templates
   * as slash commands. Defaults to the real disk scanner; injected as a no-op by
   * tests so they never touch disk. */
  registerCustomCommands?: (opts: { cwd: string; osHome: string }) => Promise<unknown>
  /** Persist a captured plan to `~/.cognia/plans`; defaults to the real writer.
   * Returns the path written (or null on failure). Injected as a no-op by tests. */
  persistPlan?: (home: string, fileName: string, raw: string) => string | null
  /** Start a streaming `/goal` run; defaults to {@link runGoalStreaming}. Injected
   * by tests so they don't touch the CLI-local db / judge. */
  startGoalRun?: typeof runGoalStreaming
  /** Start a streaming `/loop` run; defaults to {@link runLoopStreaming}. Injected
   * by tests so they don't touch the CLI-local db / loop engine. */
  startLoopRun?: typeof runLoopStreaming
  /** Start a streaming `/fix` test-fix loop; defaults to {@link runFixStreaming}.
   * Injected by tests so they don't spawn a real test process. */
  startFixRun?: typeof runFixStreaming
  /** `@` mention candidate sources for the composer popup + submit-time
   * preprocessing. Defaults to the real disk/db providers; injected by tests so
   * the composer never touches a live db / disk. */
  mentionProviders?: MentionProviders
  /** Enable + persist a skill referenced by a `@skill:` mention; defaults to the
   * real `skill-state.json` writer. Injected as a no-op by tests so they never
   * touch the real home. */
  persistSkillEnabled?: (id: string) => void
  /** Read an image off the OS clipboard (Ctrl+V). Defaults to the real
   * cross-platform helper; injected by tests so they never touch a real
   * clipboard. Resolves the temp file path, or null when the clipboard holds no
   * image. */
  readClipboardImage?: () => Promise<{ path: string } | null>
  /** Terminal capability snapshot that gates the fullscreen layout; defaults to
   * the live process (non-TTY ⇒ scrollback). Injected by tests to exercise the
   * fixed-region tree without a real TTY. */
  layoutCapability?: LayoutCapability
  /** Sink for the alternate-screen enter/exit escapes; defaults to the Ink
   * stdout. Injected by tests to assert the lifecycle. */
  screenOut?: ScreenStream
  /** Tap on Ink's committed frames, created by `mount.tsx` and handed to
   * `render()` as the stdout. In-app drag-to-select reads the on-screen text
   * from it; absent (tests, embedders) the feature simply never engages. */
  frames?: FrameBuffer
  /** True when `mount.tsx` already entered + cleared the alternate screen BEFORE
   * Ink's first paint (the production fullscreen path). The App's alt-screen
   * effect then skips the redundant enter/clear that would otherwise wipe Ink's
   * first frame and leave a blank screen until a resize. Defaults to false so
   * tests (which render App directly) still drive the full enter on mount. */
  altScreenPreEntered?: boolean
  /** Sink for the dynamic terminal-title escapes; defaults to the Ink stdout.
   * Kept distinct from {@link screenOut} so the title writes never pollute the
   * alt-screen lifecycle assertions. Injected by tests to assert the title. */
  titleOut?: TitleStream
  /** Env slice steering terminal-title adaptation (tmux / screen / dumb);
   * defaults to `process.env`. Injected by tests. */
  titleEnv?: TitleEnv
}

export function App({
  config,
  sessionId,
  createSession,
  createExternalSession,
  connectBackendFn,
  resolveInstallOptionFn,
  runInstallFn,
  pushHandoff,
  onExit,
  now = Date.now,
  mintId = () => mintSessionId(),
  listDir,
  home = resolveHome(process.env, os.homedir()),
  osHome = os.homedir(),
  readdir,
  transcriptFs,
  copyClipboard = (text: string) =>
    copyToClipboard(text, {
      osc52: config.clipboard?.osc52,
      osc52MaxBytes: config.clipboard?.osc52MaxBytes,
      env: process.env,
    }),
  persistConfig,
  persistProviderModel,
  persistBackendModel,
  listExternalModels,
  persistCredential,
  clearScreen = clearTerminal,
  persistDb = () => {
    void ensureCliDb()
      .then((handle) => handle.scheduleFlush())
      .catch(() => {})
  },
  runShell = defaultRunShell,
  runInteractiveShell = defaultRunInteractiveShell,
  persistToolApproval = addToolApproval,
  trusted = true,
  trustFolderFn = defaultTrustFolder,
  listDirs,
  persistStatusBar = setStatusBarConfig,
  persistMascot = setMascotConfig,
  persistEditor = setEditorConfig,
  openInEditorFn = openInEditor,
  loadPlanFile = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return null
    }
  },
  persistPluginTools = setPluginToolsConfig,
  initialHistory = [],
  initialCommand,
  sessionOnlyPermissionMode,
  persistHistory = (entry) => {
    try {
      appendHistory(home, entry)
    } catch {
      // best-effort — a read-only home shouldn't break the turn.
    }
  },
  resolveMeta = resolveModelMeta,
  initOpenRouterCatalog = defaultInitOpenRouterCatalog,
  registerCustomCommands = defaultRegisterCustomCommands,
  persistPlan = savePlan,
  startGoalRun = runGoalStreaming,
  startLoopRun = runLoopStreaming,
  startFixRun = runFixStreaming,
  mentionProviders: mentionProvidersProp,
  persistSkillEnabled,
  readClipboardImage = defaultReadClipboardImage,
  layoutCapability,
  screenOut,
  frames,
  altScreenPreEntered,
  titleOut,
  titleEnv,
}: AppProps) {
  const { exit, suspendTerminal } = useApp()
  const [state, dispatch] = useReducer(tuiReducer, undefined, () =>
    createInitialState(config, sessionId, trusted, initialHistory)
  )
  // One owner for the external backend's connect attempt, process, and
  // teardown. A ref (not state) because it is read when a session is lazily
  // created, never rendered. Cancellation here is AUTHORITATIVE: a process that
  // finishes registering after a cancel is reclaimed rather than merely ignored,
  // which is what the old local `cancelled` flag could not do.
  const connectionRef = useRef<BackendConnection | null>(null)
  const lifecycleRef = useRef<BackendLifecycle<BackendConnection> | null>(null)
  const externalModelRequestRef = useRef(0)
  // The install option resolved for the current failure (a ref so the failure
  // page's "install" handler reads the latest without recreating the callback).
  const installOptionRef = useRef<BackendInstallOption | null>(null)
  const installAbortRef = useRef<AbortController | null>(null)
  const activeBackend = state.config.agentBackend ?? "builtin"
  useEffect(() => {
    // Invalidate an in-flight external catalog read whenever the selected/live
    // backend identity changes. The resolver also checks the connection ref,
    // so disconnects cannot publish their late results.
    externalModelRequestRef.current += 1
  }, [activeBackend, state.backendCapabilities?.backend])
  // Route session creation to the backend the user has selected RIGHT NOW.
  // `/backend` drops the live session, so a changed identity here always lands
  // on a fresh session rather than being ignored by the existing one.
  const activeCreateSession = useCallback<CreateSession>(
    (params) => {
      if (isBuiltinBackend(activeBackend)) {
        return (createSession ?? createAgentSession)(params)
      }
      if (!createExternalSession) {
        // Refuse rather than quietly answering on the built-in agent — the whole
        // point of the backend selection is that the user knows who replied.
        // `send` catches this and renders it as a turn error.
        throw new Error(`No external-agent session factory is available for "${activeBackend}".`)
      }
      const connection = connectionRef.current
      return createExternalSession({
        ...params,
        config: { ...params.config, agentBackend: activeBackend },
        ...(connection
          ? {
              connection: {
                agentId: connection.agentId,
                presetId: connection.presetId,
                ...(connection.negotiated
                  ? { capabilities: { negotiated: connection.negotiated } }
                  : {}),
              },
              onToolHostStatus: (toolHost) => {
                const live = connectionRef.current
                if (!live || live.agentId !== connection.agentId) return
                dispatch({
                  type: "BACKEND_CAPABILITIES_UPDATE",
                  capabilities: externalCapabilities({
                    backend: live.backend,
                    presetId: live.presetId,
                    ...(live.capabilities.protocol ? { protocol: live.capabilities.protocol } : {}),
                    ...(live.negotiated ? { negotiated: live.negotiated } : {}),
                    toolHost,
                  }),
                })
              },
            }
          : {}),
      })
    },
    [activeBackend, createSession, createExternalSession]
  )
  // Mounted ONCE for the app's lifetime (never per turn): the external-agent
  // emitter has the default 10-listener cap, and a MaxListenersExceededWarning
  // would print to stderr straight through the Ink frame.
  const { pushLog, clearLogs } = useLogIngest({ dispatch })
  const standaloneAgent = useAgentSession({
    config: state.config,
    dispatch,
    onLog: pushLog,
    // Bind the chat session to the live app id so its transcript lands under the
    // id `/export`/`/handoff`/`/resume` read (it tracks `/clear` + `/resume`).
    sessionId: state.sessionId,
    createSession: activeCreateSession,
    ...(state.backendCapabilities ? { capabilities: state.backendCapabilities } : {}),
    getCellCount: () => state.cells.length,
    // Seed the live auto-approve set from THIS app's home (not the OS home) so
    // it matches `persistToolApproval`'s store and stays hermetic under test.
    resolveApprovedTools: () => readToolApprovals(home, undefined, state.config.cwd),
  })
  const attachedHostAbortRef = useRef<AbortController | null>(null)
  const attachedHostConnectionRef = useRef<AttachedHostConnection | null>(null)
  const attachedHostRevisionRef = useRef<number>(0)
  const attachHost = useCallback(
    async (options: { targetId: string; sessionId?: string; accountId?: string }) => {
      attachedHostAbortRef.current?.abort()
      const controller = new AbortController()
      attachedHostAbortRef.current = controller
      try {
        const connection = await attachLocalHost(
          {
            ...options,
            signal: controller.signal,
            onHostStateSnapshot: (snapshot) => {
              attachedHostRevisionRef.current = snapshot.revision
            },
            onHostStateEvent: (event) => {
              if (event.mutation && "revision" in event.mutation) {
                attachedHostRevisionRef.current = Math.max(
                  attachedHostRevisionRef.current,
                  event.mutation.revision
                )
              }
              if (event.outcome === "rejected" || event.outcome === "conflicted") {
                dispatch({
                  type: "NOTICE",
                  message: resolveHostStateMessage("outcome", {
                    outcome: event.outcome,
                    code: event.rejection?.code ?? "unknown",
                  }),
                  severity: "warn",
                })
              }
            },
            onAgentEvent: (envelope) => {
              if (!options.sessionId || envelope.sessionId !== options.sessionId) return
              for (const action of canonicalEnvelopeToActions(envelope)) dispatch(action)
            },
          },
          { home }
        )
        attachedHostConnectionRef.current = connection
        attachedHostRevisionRef.current = Math.max(
          attachedHostRevisionRef.current,
          connection.snapshot.revision
        )
        await flushAttachedHostStateOutbox(connection, { home })
        for (const subscription of connection.subscriptions) {
          void subscription.catch((error: unknown) => {
            if (controller.signal.aborted) return
            dispatch({
              type: "NOTICE",
              message: resolveHostStateMessage("disconnected", {
                error: error instanceof Error ? error.message : String(error),
              }),
              severity: "error",
            })
          })
        }
        return resolveHostStateMessage("attached", {
          target: connection.record.runtimeTargetId,
          session: connection.record.sessionId
            ? resolveHostStateMessage("sessionSuffix", { session: connection.record.sessionId })
            : "",
          generation: connection.record.hostGeneration,
        })
      } catch (error) {
        controller.abort()
        attachedHostConnectionRef.current = null
        if (attachedHostAbortRef.current === controller) attachedHostAbortRef.current = null
        throw error
      }
    },
    [home]
  )
  const detachHost = useCallback(async () => {
    attachedHostAbortRef.current?.abort()
    attachedHostAbortRef.current = null
    attachedHostConnectionRef.current = null
    attachedHostRevisionRef.current = 0
    detachLocalHost({ home })
    return resolveHostStateMessage("detached")
  }, [home])
  const hostSyncStatus = useCallback(async () => {
    const connection = await attachedHostStatus({ home })
    if (!connection) return resolveHostStateMessage("standalone")
    const { record, status } = connection
    const rows = readAttachedHostStateOutbox({ home }).filter(
      (row) =>
        row.action.accountId === record.accountId &&
        row.action.runtimeTargetId === record.runtimeTargetId
    )
    const pending = rows.filter(
      (row) => row.status === "pending" || row.status === "sending"
    ).length
    const terminal = rows.filter(
      (row) => row.status === "rejected" || row.status === "conflicted"
    ).length
    return resolveHostStateMessage("status", {
      target: record.runtimeTargetId,
      generation: status.hostGeneration,
      hostSeq: status.hostSeq,
      pending,
      terminal,
      pendingDispatch: status.pendingDispatch,
      pendingBroadcast: status.pendingBroadcast,
    })
  }, [home])
  useEffect(
    () => () => {
      attachedHostAbortRef.current?.abort()
      attachedHostAbortRef.current = null
      attachedHostConnectionRef.current = null
    },
    []
  )
  useEffect(() => {
    let record: ReturnType<typeof readAttachedHost>
    try {
      record = readAttachedHost({ home })
    } catch (error) {
      dispatch({
        type: "NOTICE",
        message: resolveHostStateMessage("invalidSavedAttachment", {
          error: error instanceof Error ? error.message : String(error),
        }),
        severity: "error",
      })
      return
    }
    if (!record) return
    void attachHost({
      targetId: record.runtimeTargetId,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      accountId: record.accountId,
    })
      .then((message) => dispatch({ type: "NOTICE", message }))
      .catch((error: unknown) =>
        dispatch({
          type: "NOTICE",
          message: resolveHostStateMessage("reattachFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          severity: "warn",
        })
      )
  }, [attachHost, home])
  const submitAttachedIntent = useCallback(
    async (intent: AllowedHostStateIntent) => {
      const connection = attachedHostConnectionRef.current
      if (!connection) return null
      const action = queueAttachedHostStateAction(connection.record, intent, { home })
      const rows = await flushAttachedHostStateOutbox(connection, { home })
      const row = rows.find((candidate) => candidate.action.actionId === action.actionId)
      if (!row?.receipt) throw new Error(row?.lastError ?? "host_state_receipt_missing")
      if (row.status === "rejected" || row.status === "conflicted") {
        throw new Error(row.receipt.rejection?.code ?? `host_state_${row.status}`)
      }
      return row.receipt
    },
    [home]
  )
  const agent = useMemo<AgentSessionApi>(
    () => ({
      ...standaloneAgent,
      async send(prompt) {
        const connection = attachedHostConnectionRef.current
        if (!connection) return standaloneAgent.send(prompt)
        if (!connection.record.sessionId) {
          dispatch({
            type: "TURN_ERROR",
            message: resolveHostStateMessage("sessionRequired"),
          })
          return null
        }
        try {
          const action = queueAttachedHostStateAction(
            connection.record,
            {
              kind: "message.enqueue",
              messageId: randomUUID(),
              text: prompt,
              attachments: [],
            },
            { home }
          )
          dispatch({ type: "TURN_START", prompt })
          const rows = await flushAttachedHostStateOutbox(connection, { home })
          const row = rows.find((candidate) => candidate.action.actionId === action.actionId)
          if (row?.status === "rejected" || row?.status === "conflicted") {
            throw new Error(row.receipt?.rejection?.code ?? `host_state_${row.status}`)
          }
        } catch (error) {
          dispatch({
            type: "TURN_ERROR",
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return null
      },
      abort() {
        if (!attachedHostConnectionRef.current) {
          standaloneAgent.abort()
          return
        }
        void submitAttachedIntent({ kind: "turn.abort" }).catch((error: unknown) =>
          dispatch({
            type: "NOTICE",
            message: resolveHostStateMessage("abortPending", {
              error: error instanceof Error ? error.message : String(error),
            }),
            severity: "warn",
          })
        )
      },
      resolvePermission(decision) {
        const connection = attachedHostConnectionRef.current
        if (!connection) {
          standaloneAgent.resolvePermission(decision)
          return
        }
        if (state.overlay.kind !== "permission") return
        const requestId = state.overlay.req.requestId
        void submitAttachedIntent({
          kind: "approval.respond",
          requestId,
          decision: decision.decision,
        })
          .then(() => dispatch({ type: "OVERLAY_CLOSE" }))
          .catch((error: unknown) =>
            dispatch({
              type: "NOTICE",
              message: resolveHostStateMessage("approvalPending", {
                error: error instanceof Error ? error.message : String(error),
              }),
              severity: "warn",
            })
          )
      },
      async forkConversationAt(cellCount, cells) {
        if (!attachedHostConnectionRef.current) {
          return standaloneAgent.forkConversationAt(cellCount, cells)
        }
        dispatch({
          type: "NOTICE",
          message: resolveHostStateMessage("transcriptBoundaryRequired"),
          severity: "warn",
        })
      },
    }),
    [dispatch, home, standaloneAgent, state.overlay, submitAttachedIntent]
  )
  const busy = isBusy(state)
  const overlayOpen = state.overlay.kind !== "none"
  const [interruptedBackgroundSubagents, setInterruptedBackgroundSubagents] = useState(0)

  // Session-enabled skill ids — drives the ●/○ badge in the `@` mention popup and
  // is kept live so a Shift+Tab toggle reflects immediately. Seeded from
  // `skill-state.json` under THIS app's home (best-effort; empty on a fresh home).
  const [enabledSkillIds, setEnabledSkillIds] = useState<Set<string>>(() => {
    try {
      return readEnabledSkills(home)
    } catch {
      return new Set<string>()
    }
  })
  // Flip a skill's enabled state from the popup: persist, refresh the live set so
  // the badge updates, and invalidate the cached SendOptions so the next turn
  // reflects the change. Routes through the injected `persistSkillEnabled` writer
  // when present (tests) but always derives the new set locally.
  const toggleSkillEnabled = useCallback(
    (id: string, enabled: boolean) => {
      try {
        setSkillEnabled(home, id, enabled)
      } catch {
        // read-only home shouldn't break the popup; the in-memory set still updates.
      }
      setEnabledSkillIds((prev) => {
        const next = new Set(prev)
        if (enabled) next.add(id)
        else next.delete(id)
        return next
      })
      agent.invalidate()
      dispatch({
        type: "NOTICE",
        message: `Skill "${id}" ${enabled ? "enabled" : "disabled"} for this session.`,
      })
    },
    [home, agent]
  )
  // Whether the composer popup currently owns input — read by the wheel handler
  // so the transcript doesn't scroll while the popup is being wheel-scrolled.
  const composerPopupOpen = useRef(false)
  // The run-state chip row in the BottomStatus, so a click on the subagent chip
  // opens the `/agents` panel (parity with Ctrl+B).
  const subagentChipRef = useRef<DOMElement | null>(null)
  // The running-agents tree in the BottomStatus: BottomStatus publishes the
  // rendered box + agent rows here so a click on a row opens that agent's live
  // run page directly (Claude Code parity).
  const agentTreeRef = useRef<AgentTreeHit | null>(null)
  // The persistent status footer row + its rendered segments, so a click on the
  // model/mode/thinking segment opens the matching picker (Claude Code parity).
  const footerRowRef = useRef<DOMElement | null>(null)
  const footerSegmentsRef = useRef<StatusSegmentView[] | null>(null)
  // The fullscreen scroll viewport's content box (its `marginTop={-offset}`
  // encodes the scroll position), so a transcript click can be mapped to the
  // cell under it when the click-to-expand pref is on.
  const scrollContentRef = useRef<DOMElement | null>(null)
  // Stable callbacks for the memoized <Input>: an inline arrow / default-param
  // arrow would be a fresh reference each render and defeat React.memo, making
  // the composer re-render (and re-run slash/mention matching) on every delta.
  const handlePopupOpenChange = useCallback((open: boolean) => {
    composerPopupOpen.current = open
  }, [])
  const persistHistoryRef = useRef(persistHistory)
  useEffect(() => {
    persistHistoryRef.current = persistHistory
  }, [persistHistory])
  const handleHistoryPush = useCallback((entry: string) => {
    persistHistoryRef.current(entry)
  }, [])

  // Bridge the `ask_user` elicitation store into the overlay system: when the
  // agent calls `ask_user`, mirror the active prompt into an `askUser` overlay
  // and hand the dialog a resolver that settles the blocked tool call. Without
  // this the tool call never resolves and the turn hangs.
  const askUser = useAskUserOverlay(state.overlay.kind, dispatch)

  // Composer inline-autosuggest tiers. The local one is opt-out; the model one
  // is opt-in (it bills) and resolves its client lazily on first use, so a
  // configured-but-unused tier costs nothing. Memoised on the inputs the
  // completion closure actually captures, so the composer's engine is not torn
  // down on unrelated config churn.
  const localSuggestEnabled = isLocalSuggestEnabled(state.config)
  const aiSuggestEnabled = isAiSuggestEnabled(state.config)
  const aiComplete = useMemo(
    () =>
      aiSuggestEnabled
        ? createTuiInlineComplete({ sessionId: state.sessionId, config: state.config })
        : null,
    [aiSuggestEnabled, state.sessionId, state.config]
  )

  // `@` mention providers — shared by the composer popup and submit-time
  // preprocessing. Reuse the same skill/agent discovery the `/skill` + `/agents`
  // controllers use. Rebuilt only when the cwd / skill config changes.
  const mentionProviders = useMemo(
    () =>
      mentionProvidersProp ??
      createMentionProviders({
        cwd: state.config.cwd,
        home,
        osHome,
        roots: [state.config.cwd, home],
        externalSkills: state.config.externalSkills,
        skillDirs: state.config.skillDirs,
      }),
    [
      mentionProvidersProp,
      state.config.cwd,
      home,
      osHome,
      state.config.externalSkills,
      state.config.skillDirs,
    ]
  )
  // Resolve the active colour palette from the theme config. Re-resolves only
  // when the theme name changes (reuse/custom themes read a file; built-ins
  // don't), so the whole UI recolours in place on `/theme`. `resolveTheme` only
  // reads `config.theme`; pinning deps to the theme name avoids re-reading
  // reuse/custom theme files on every unrelated config change.
  const themePalette = useMemo(
    () => resolveTheme(state.config, { osHome, cogniaHome: home, read: readThemeFile }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.config.theme, osHome, home]
  )
  // Resolved transcript render preferences (highlight/line-numbers/truncation),
  // re-derived only when the `render` config object changes.
  const renderPrefs = useMemo(() => resolveRenderConfig(state.config.render), [state.config.render])
  // Resolved copy/clipboard notice strings (defaults ⊕ user overrides).
  const notices = useMemo(() => resolveNotices(state.config.notices), [state.config.notices])
  // Resolved keyboard bindings (defaults ⊕ user overrides), for both the global
  // chord handler below and the composer's editor chords.
  const keybindings = useMemo(
    () => resolveKeybindings(state.config.keybindings),
    [state.config.keybindings]
  )
  // Abort controller for the active background runtime run (goal/workflow/…).
  // Exposed to `useApplyEffect` through stable accessors (not the raw ref) so the
  // hook never mutates a prop.
  const runtimeAbort = useRef<AbortController | null>(null)
  const setRuntimeAbort = useCallback((c: AbortController | null) => {
    runtimeAbort.current = c
  }, [])
  const getRuntimeAbort = useCallback(() => runtimeAbort.current, [])

  const runSuspendedInteractiveShell = useCallback(
    async (command: string, opts: RunInteractiveShellOpts) => {
      let result: ShellResult | undefined
      await suspendTerminal(async () => {
        result = await runInteractiveShell(command, opts)
      })
      if (!result) throw new Error("Interactive shell exited without a result")
      return result
    },
    [runInteractiveShell, suspendTerminal]
  )

  // The `!command` shell-out cluster (live cells + foreground/background lifecycle
  // + last-failure capture for `/analyze`). `runBash` is consumed by `applyEffect`
  // and `handleSubmit`; the kill/background entry points by the key handler.
  const {
    runBash,
    backgroundForegroundBash,
    killForegroundBash,
    killBash,
    foregroundBash,
    hasForegroundRun,
    sendInputToForeground,
    takeLastFailedBash,
  } = useBashShellout(runShell, state.config.cwd, dispatch, runSuspendedInteractiveShell)

  // Double-Esc backtrack-to-edit selection (armed/disarmed state + timer).
  const { backtrackArmed, backtrackArmedRef, armBacktrack, disarmBacktrack } = useBacktrack()

  // `btw` steer mirror — the ref the async goal/loop driver + plain-turn drain
  // read, plus `takeSteer` to drain the queue into one framed prompt.
  const { takeSteer } = useSteerQueue(state.steerQueue, dispatch)

  // Reactive terminal size. `columns` drives the full-width composer/overlays
  // (so the UI fills the terminal like Claude Code) and `rows` budgets how many
  // list rows fit before scrolling. The live frame reflows the instant this
  // updates; only the heavy `<Static>` repaint below is debounced.
  const { columns, rows } = useTerminalSize()
  const layoutBudget = terminalLayout(columns, rows)
  // Row budget for inline popups, which sit above the composer so they stay
  // compact while the composer consumes its separate density-tier row budget.
  const popupRows = Math.max(3, Math.min(10, rows - 6))

  // One shared MCP probe cache for the whole App session: the startup warm seeds
  // it, and every `/mcp` panel / tool-list / reconnect reuses it, so re-opening
  // `/mcp` renders instantly instead of re-connecting to every server.
  const mcpProbeCache = useMemo(() => createMcpProbeCache(), [])

  // Minimal MCP deps for the interactive panel's in-place actions (toggle /
  // reconnect / tools / remove). Built per render so it tracks the live config;
  // carries the shared probe cache so the panel reads cached status.
  const mcpPanelDeps = () => ({
    dispatch,
    roots: [state.config.cwd, home],
    home,
    probeCache: mcpProbeCache,
  })

  // One-time boot warm: probe every enabled MCP server once and seed the shared
  // cache (so `/mcp` opens instantly), and warn (via a NOTICE cell) about any
  // enabled remote server that needs authorization. Fires once per session as
  // soon as we enter the chat phase; the probe is async and never blocks the
  // first frame.
  const mcpAuthChecked = useRef(false)
  useEffect(() => {
    if (state.phase !== "chat" || mcpAuthChecked.current) return
    mcpAuthChecked.current = true
    void mcpAuthStartupNotices({
      dispatch,
      roots: [state.config.cwd, home],
      home,
      probeCache: mcpProbeCache,
    })
  }, [state.phase, state.config.cwd, home, dispatch, mcpProbeCache])

  // Effective layout: the configured preference (default `fullscreen`) gated by
  // terminal capability — a non-TTY / dumb terminal always falls back to the
  // scrollback `<Static>` tree (which is also why every existing test, rendered
  // under jsdom with no TTY, keeps the historic layout untouched).
  const capability = layoutCapability ?? readLayoutCapability()
  const fullscreen = resolveLayoutMode(state.config.layout, capability) === "fullscreen"
  const overlayRegionRef = useRef<DOMElement | null>(null)
  const overlayMetrics = useBoxMetrics(overlayRegionRef)
  // The region is measured after Yoga allocates the fixed bottom chrome. Until
  // that first pass, use a conservative fallback; overflow clipping still makes
  // the actual region authoritative.
  const overlayViewportRows = overlayMetrics.hasMeasured
    ? overlayMetrics.height
    : Math.max(1, rows - (layoutBudget.tier === "tiny" ? 1 : 3))
  // Fullscreen mouse model (default = native click-drag selection). Drives the
  // alt-screen mouse escapes below and whether the wheel scrolls the transcript.
  const mouseMode = state.config.mouse ?? DEFAULT_MOUSE_MODE
  // In-app drag-to-select. Only engages in fullscreen (the layout that owns the
  // mouse) and only once a frame buffer is available to select over.
  const selectionMode = state.config.selection ?? DEFAULT_SELECTION_MODE

  const { stdout } = useStdout()
  // Sink for the alt-screen enter/exit + mouse escapes (also re-applied live by
  // `applyEffect`'s `mouse` case, so it stays in App scope).
  const screen: ScreenStream = screenOut ?? (stdout as unknown as ScreenStream)
  // Title/bell inputs, derived once and fed to the terminal-chrome hook below.
  const titleEnabled = state.config.terminalTitle !== false
  const titleSink: TitleStream = titleOut ?? (stdout as unknown as TitleStream)
  const awaitingInput = state.overlay.kind === "permission" || state.overlay.kind === "askUser"
  const activityKind =
    state.activity && state.activity.status === "running" ? state.activity.kind : undefined
  const notifyEnabled = state.config.notify === true
  // Desktop notifications ride on top of the bell: enabled only when notify is on
  // AND the user hasn't explicitly opted out (`desktopNotifications: false`).
  const desktopNotifyEnabled = notifyEnabled && state.config.desktopNotifications !== false

  // Terminal-integration effects: alt-screen + mouse lifecycle, dynamic
  // window/tab title, opt-in completion bell, and the scrollback resize repaint.
  useTerminalChrome({
    fullscreen,
    screen,
    mouseMode,
    // Button-event tracking (`?1002h`) is what makes a drag visible to the TUI,
    // so it is seeded with the alt screen whenever selection is on.
    mouseDrag: selectionMode !== "off",
    altScreenPreEntered,
    stdout,
    clearScreen,
    dispatch,
    titleEnabled,
    titleSink,
    titleEnv,
    busy,
    awaitingInput,
    activityKind,
    cwd: state.config.cwd,
    notifyEnabled,
    desktopNotifyEnabled,
    lastCompletion: state.lastCompletion,
    now,
  })

  // In-app drag-to-select over the captured frame. Held in a ref (never in
  // state) so a drag repaints the highlight without re-rendering the tree —
  // see `selection/selection-controller`. Only mounted in fullscreen, since the
  // frame the selection reads is the alt-screen frame.
  const selectionRef = useTextSelection({
    frames: fullscreen ? frames : undefined,
    mode: selectionMode,
    copy: copyClipboard,
    notify: (message) => dispatch({ type: "NOTICE", message }),
    failureMessage: (reason) => clipboardFailureMessage(reason, notices),
    now,
  })

  // Scroll controller for the fullscreen viewport (no-op in scrollback mode,
  // where the terminal's native scrollback handles it).
  const scroll = useScroll()
  // Stable reference for the submit/clear re-pin (the rest of `scroll` is read
  // during render, but this one is closed over by callbacks).
  const scrollReset = scroll.reset
  // Find-in-viewport cursor (fullscreen only). Drives the FindBar, the focused
  // cell's highlight, per-cell copy, and the jump-to-match scroll below.
  const cursor = useTranscriptCursor(state.cells, fullscreen && renderPrefs.clickToExpand)
  // Jump the viewport so the focused match lands ~1/3 down, re-running as the
  // gated per-cell measurements settle (cursor.targetRow folds in their version).
  const cursorTargetRow = cursor.targetRow
  useEffect(() => {
    if (cursorTargetRow !== null) scroll.toRow(cursorTargetRow)
    // `scroll.toRow` is rebuilt every render; depend only on the target so a jump
    // fires when the focus/measurement changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorTargetRow])

  // Resolve the active model's context window + pricing from the models.dev
  // catalog whenever the provider or model changes, so the context gauge sizes
  // to the real window (not the 200k fallback) and the cost segment can price
  // turns the SDK reports as $0 (every non-Anthropic provider). Best-effort and
  // async — a missing catalog leaves the pattern-table window in place.
  const activeMetaTarget = useMemo(
    () => backendModelMetaTarget(state.config, state.backendCapabilities?.presetId),
    [state.config, state.backendCapabilities?.presetId]
  )
  const activeModel = activeMetaTarget.model
  const activeProvider = activeMetaTarget.provider
  useEffect(() => {
    let cancelled = false
    void countInterruptedCliBackgroundRuns({ home, owner: state.sessionId })
      .then((count) => {
        if (!cancelled) setInterruptedBackgroundSubagents(count)
      })
      .catch(() => {
        if (!cancelled) setInterruptedBackgroundSubagents(0)
      })
    return () => {
      cancelled = true
    }
  }, [home, state.sessionId])

  useEffect(() => {
    let cancelled = false
    void resolveMeta(activeProvider, activeModel)
      .then((meta) => {
        if (!cancelled) dispatch({ type: "SET_MODEL_META", meta })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [resolveMeta, activeProvider, activeModel])

  // Prime + background-refresh the OpenRouter live-models catalog whenever
  // OpenRouter is the active provider, so the `/model` picker reflects the synced
  // real-time list (the same shared row the desktop GUI uses). Gated on the
  // provider so a user who never touches OpenRouter pays no db/network cost.
  // Best-effort — the controller swallows its own failures.
  const openRouterApiKey = state.config.providers.openrouter?.apiKey
  useEffect(() => {
    if (activeProvider !== "openrouter") return
    void initOpenRouterCatalog({ apiKey: openRouterApiKey })
  }, [activeProvider, initOpenRouterCatalog, openRouterApiKey])

  // Discover user-authored `.claude/commands` / `.cognia/commands` prompt
  // templates and register them as slash commands. Registration is guarded +
  // idempotent, so the effect is safe to re-run; `matchSlash` reads the registry
  // live, so the new commands surface the moment the async scan resolves — same
  // contract as the OpenRouter catalog init above. Best-effort (swallows errors).
  useEffect(() => {
    void registerCustomCommands({ cwd: state.config.cwd, osHome })
  }, [registerCustomCommands, state.config.cwd, osHome])

  // For a dynamic-catalog provider (OpenRouter) the synced live list may not be
  // primed when the `/model` picker opens. Kick off a sync and swap the full
  // real-time catalog into the still-open picker the moment it lands — without
  // this the picker shows the static fallback subset and looks like it "never
  // updates". No-op for every other provider (their lists are static/synchronous).
  const syncAndRefreshModelOverlay = useCallback(() => {
    if (state.config.provider !== "openrouter") return
    void initOpenRouterCatalog({ apiKey: openRouterApiKey }).then(() => {
      dispatch({
        type: "OVERLAY_REFRESH_MODEL_OPTIONS",
        options: collectModelOptions(state.config),
      })
    })
  }, [state.config, dispatch, initOpenRouterCatalog, openRouterApiKey])

  // Open the `/model` switcher instantly with whatever models are cached, then
  // live-refresh once the dynamic catalog sync resolves.
  const openModelPicker = useCallback(() => {
    // While an external agent hosts, the built-in provider's catalog is the
    // wrong list — those are not models that agent can run, and picking one used
    // to send the id straight into its session. Native Codex has a global
    // `model/list`; ACP exposes model options only from the live session.
    const caps = state.backendCapabilities
    if (caps && !caps.builtin) {
      if (!supportsFeature(caps, "modelPicker")) {
        dispatch({ type: "NOTICE", message: unsupportedFeatureMessage(caps, "modelPicker") })
        return
      }
      const agentId = connectionRef.current?.agentId
      if (!agentId) {
        dispatch({ type: "NOTICE", message: "The agent is not connected yet." })
        return
      }
      const isAcp = caps.protocol === "acp"
      const list = listExternalModels ?? defaultBackendModelHost().listExternalModels
      const unavailableMessage = isAcp
        ? `${caps.backend} did not expose model options for the active ACP session. Send a message first, then retry.`
        : `${caps.backend} did not report any models.`
      const requestId = ++externalModelRequestRef.current
      const isCurrentRequest = () => {
        return (
          externalModelRequestRef.current === requestId &&
          connectionRef.current?.agentId === agentId
        )
      }
      const modelsPromise = isAcp ? agent.listModels() : list(agentId)
      void modelsPromise.then(
        (models) => {
          if (!isCurrentRequest()) return
          if (models.length === 0) {
            dispatch({ type: "NOTICE", message: unavailableMessage })
            return
          }
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: {
              kind: "model",
              options: models.map((m) => m.id),
              labels: Object.fromEntries(
                models.map((model) => [model.id, formatExternalModelLabel(model)])
              ),
              index: 0,
              query: "",
            },
          })
        },
        () => {
          if (!isCurrentRequest()) return
          dispatch({ type: "NOTICE", message: unavailableMessage })
        }
      )
      return
    }
    const options = collectModelOptions(state.config)
    if (options.length === 0) {
      dispatch({
        type: "NOTICE",
        message: "No models configured. Set one with `cognia-agent config set model <id>`.",
      })
      return
    }
    dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "model", options, index: 0, query: "" } })
    syncAndRefreshModelOverlay()
  }, [
    state.config,
    state.backendCapabilities,
    dispatch,
    syncAndRefreshModelOverlay,
    listExternalModels,
    agent,
  ])

  // When a plan-mode turn proposes a plan (the reducer captured it as
  // `lastPlan`), persist it to `~/.cognia/plans` and open the approval prompt —
  // the OpenCode `plan_exit` flow. The ref guards against re-firing for the same
  // plan when unrelated state changes re-run the effect.
  // Keyed by session + seq so a RESET (which restarts seq from 0) can't make a
  // fresh plan collide with one already handled in a previous session.
  const handledPlanSeq = useRef<string | null>(null)
  useEffect(() => {
    const plan = state.lastPlan
    const key = plan ? `${state.sessionId}:${plan.seq}` : null
    if (!plan || handledPlanSeq.current === key) return
    handledPlanSeq.current = key
    let savedTo: string | undefined
    try {
      savedTo = persistPlan(home, planFileName(state.sessionId, plan.seq), plan.raw) ?? undefined
    } catch {
      savedTo = undefined
    }
    if (savedTo) dispatch({ type: "NOTICE", message: `Plan saved to ${savedTo}` })
    dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "plan",
        raw: plan.raw,
        index: 0,
        ...(savedTo ? { savedTo } : {}),
        ...(plan.prevRaw ? { prevPlan: plan.prevRaw } : {}),
      },
    })
  }, [state.lastPlan, state.sessionId, home, persistPlan])

  // Bridge `state.copilot` (driven by the COPILOT_* actions the runtime
  // controller dispatches) to the agent session: entering routes `send` to a
  // dedicated workflow-editor session, exiting tears it down. A ref to the
  // latest agent api keeps this effect keyed only on the workflow id (the hook
  // returns a fresh object each render), so enter/exit fires once per change.
  const agentRef = useRef(agent)
  useEffect(() => {
    agentRef.current = agent
  })

  // OpenCode-style auto-compaction: when the live context crosses the configured
  // fill threshold, compact it between turns (idle only) so a long session shrinks
  // itself instead of overflowing into dropped history. Armed off the usage
  // fraction so it fires once per crossing, not on every render — it re-arms once
  // the fraction falls back under the threshold after a compaction.
  const autoCompactArmed = useRef(true)
  useEffect(() => {
    if (state.turnStatus !== "idle") return
    const fire = shouldAutoCompact({
      usage: state.usage,
      model: activeModel,
      contextWindow: state.modelMeta?.contextWindow,
      enabled: state.config.autoCompact !== false,
      threshold: state.config.autoCompactThreshold,
    })
    if (!fire) {
      autoCompactArmed.current = true
      return
    }
    if (!autoCompactArmed.current) return
    autoCompactArmed.current = false
    void agentRef.current.compact()
  }, [
    state.usage,
    state.turnStatus,
    activeModel,
    state.modelMeta?.contextWindow,
    state.config.autoCompact,
    state.config.autoCompactThreshold,
  ])
  const copilotWorkflowId = state.copilot?.workflowId
  useEffect(() => {
    if (copilotWorkflowId) agentRef.current.enterCopilot(copilotWorkflowId)
    else void agentRef.current.exitCopilot()
  }, [copilotWorkflowId])

  const exitingRef = useRef(false)
  const doExit = useCallback(() => {
    if (exitingRef.current) return
    exitingRef.current = true
    dispatch({ type: "EXIT" })
    agent.abort()
    getRuntimeAbort()?.abort()
    // Unmount Ink immediately. Session/backend cleanup is best-effort and may
    // wait on an unresponsive child process; keeping the TUI mounted until it
    // settles makes a successful exit look hung and invites another Ctrl+C,
    // which kills the pnpm process and surfaces as ELIFECYCLE.
    if (onExit) onExit()
    else exit()
    void (async () => {
      try {
        await agent.close()
        const lifecycle = lifecycleRef.current
        if (lifecycle) await lifecycle.dispose()
        else await disconnectBackend(connectionRef.current)
        connectionRef.current = null
      } catch {
        // Exiting must not be converted into an unhandled rejection when a
        // backend has already stopped or refuses to acknowledge shutdown.
      }
    })()
  }, [agent, exit, getRuntimeAbort, onExit])

  // Startup trust gate: "Yes, proceed" trusts the current cwd and enters chat.
  const trustCwd = useCallback(() => {
    try {
      trustFolderFn(home, state.config.cwd)
    } catch {
      // A read-only home shouldn't block the session — just don't remember it.
    }
    dispatch({ type: "STARTUP_TRUST" })
  }, [home, trustFolderFn, state.config.cwd])

  // Folder picker confirmed a directory (or `/cd <dir>`): switch cwd, trust it,
  // and enter chat. `agent.changeCwd` dispatches SET_CWD and recreates the
  // session so the new cwd reaches the next turn (and respawns the sidecar under
  // it). A live mid-session `/cd` therefore actually relocates the agent, not
  // just the `/cwd` display.
  const changeCwd = useCallback(
    (dir: string) => {
      try {
        trustFolderFn(home, dir)
      } catch {
        // best-effort persistence
      }
      void agent.changeCwd(dir)
      dispatch({ type: "STARTUP_TRUST" })
    },
    [agent, home, trustFolderFn]
  )

  // Bring the external backend up while the composer is still closed. Runs on
  // every entry into the `"connecting"` phase — first launch after the trust
  // gate, a retry from the failure page, and a `/backend` switch all land here.
  // The config is read from a ref so the effect's identity depends only on the
  // phase, which is what makes "one connect per entry" true.
  const liveConfigRef = useRef(state.config)
  useEffect(() => {
    liveConfigRef.current = state.config
  }, [state.config])
  const [failureIndex, setFailureIndex] = useState(0)
  useEffect(() => {
    if (state.phase !== "connecting") return
    const backend = liveConfigRef.current.agentBackend ?? "builtin"
    let failure: BackendConnectFailure | null = null
    const lifecycle = createBackendLifecycle<BackendConnection>({
      // Loaded on demand: the external protocol stack is ~200KB of manager + ACP
      // client that a built-in session must never pay to parse.
      connect: async (attempt) => {
        const run =
          connectBackendFn ?? (await import("../runtime/backend-controller")).connectBackend
        const { commandExists } = await import("../../runtime/external/node-backend")
        const result = await run({
          backend,
          config: liveConfigRef.current,
          agentId: `cli-backend-${sessionId}`,
          commandExists,
          onStage: (stage) => {
            // A superseded attempt must not repaint the progress line.
            if (attempt === lifecycle.attempt && !lifecycle.isDisposed()) {
              dispatch({ type: "BACKEND_CONNECT_STAGE", backend, stage })
            }
          },
        })
        if (result.ok) return result.connection
        failure = result.failure
        return null
      },
      // The statically-imported reclaim, not a dynamic one: teardown must reach
      // the process synchronously enough that an unmount cannot outrun it, and
      // `disconnectBackend` is already in this module's graph anyway.
      disconnect: (connection) => disconnectBackend(connection),
    })
    lifecycleRef.current = lifecycle
    void lifecycle.start().then(async (connection) => {
      if (connection) {
        connectionRef.current = connection
        dispatch({ type: "BACKEND_CONNECT_OK", capabilities: connection.capabilities })
        return
      }
      // Superseded/cancelled attempts have already reclaimed themselves and
      // carry no failure to report.
      if (!failure) return
      const result = { ok: false as const, failure }
      // Reset the recovery cursor here rather than when the connect starts:
      // a synchronous set inside the effect body would cascade a render.
      setFailureIndex(0)
      installOptionRef.current = null
      // Only a missing binary can be fixed by installing something; every other
      // failure (platform, launcher, handshake) goes straight to the page. This
      // branch also stays synchronous so it never shifts the failure-page timing.
      if (result.failure.kind !== "command" || !result.failure.command) {
        dispatch({ type: "BACKEND_CONNECT_FAIL", failure: result.failure })
        return
      }
      // Resolve the first official install method whose prerequisites are present
      // so the failure page can offer to run it in place.
      const resolveInstallOption = resolveInstallOptionFn ?? defaultResolveInstallOption
      const installOption = await resolveInstallOption(result.failure)
      if (lifecycle.isDisposed()) return
      installOptionRef.current = installOption
      dispatch({
        type: "BACKEND_CONNECT_FAIL",
        failure: result.failure,
        ...(installOption ? { installOption } : {}),
      })
    })
    return () => {
      // Leaving the connecting phase supersedes the attempt. A result that lands
      // afterwards is reclaimed by the lifecycle rather than left registered.
      lifecycle.cancel()
    }
    // The config is read through `liveConfigRef`, deliberately keeping it out of
    // the deps: the effect must fire once per ENTRY into the connecting phase,
    // not on every unrelated config change while a connect is in flight.
  }, [state.phase, connectBackendFn, resolveInstallOptionFn, sessionId])

  // Esc during the connect: reclaim whatever the in-flight connect may have
  // registered under the stable id (the connect writes `connectionRef` only on
  // success, so at cancel time it's still null — remove by the known id), then
  // route to the recovery page. Leaving the connecting phase runs the effect's
  // cleanup, which flips its `cancelled` flag so the settling connect is a no-op.
  const cancelBackendConnect = useCallback(() => {
    // The lifecycle reclaims a process that registers after this point; the
    // by-id removal stays as a belt-and-braces for a connect that never
    // reported (no lifecycle yet, e.g. cancelled before the effect ran).
    lifecycleRef.current?.cancel()
    void disconnectBackend({ agentId: `cli-backend-${sessionId}` })
    connectionRef.current = null
    installOptionRef.current = null
    setFailureIndex(0)
    dispatch({
      type: "BACKEND_CONNECT_FAIL",
      failure: { kind: "handshake", stage: "launch", message: "Connection cancelled." },
    })
  }, [sessionId])

  // Reclaim the external agent process on unmount. The controller — not the
  // session — owns the process it started, so exiting without this orphans the
  // spawned agent (and its sandboxed child). Runs once, on teardown.
  useEffect(() => {
    return () => {
      // Dispose, not disconnect: teardown must also wait out a connect that is
      // still settling, or its process outlives the TUI.
      const lifecycle = lifecycleRef.current
      if (lifecycle) void lifecycle.dispose()
      else void disconnectBackend(connectionRef.current)
      connectionRef.current = null
    }
  }, [])

  // Reclaim the live external process when `/backend` switches to the built-in
  // agent (no reconnect follows, so it would otherwise leak until exit). An
  // external → external switch does NOT call this — its reconnect re-registers
  // under the same id and reclaims the old process itself.
  const reclaimBackend = useCallback(() => {
    lifecycleRef.current?.cancel()
    void disconnectBackend(connectionRef.current)
    connectionRef.current = null
  }, [])

  // Best-effort write of a changed setting to `~/.cognia/config.json` so a
  // `/config`-panel switch survives the next launch. A failure (read-only home,
  // bad value) surfaces as a notice rather than throwing.
  const persist = useCallback(
    (key: string, value: string): boolean => {
      try {
        if (persistConfig) return persistConfig(key, value)
        setConfigValue(home, key, value)
        return true
      } catch {
        return false
      }
    },
    [home, persistConfig]
  )

  // Persist a model under a specific provider (per-provider memory). Keyed to the
  // provider so each one reuses its own last pick and no global pin bleeds across
  // providers. Failures are swallowed (read-only home just loses persistence).
  const persistProviderModelFn = useCallback(
    (providerId: string, modelId: string): boolean => {
      try {
        if (persistProviderModel) return persistProviderModel(providerId, modelId)
        setProviderModel(home, providerId, modelId)
        return true
      } catch {
        return false
      }
    },
    [home, persistProviderModel]
  )

  // Persist a model under the EXTERNAL BACKEND that is hosting, keyed by the
  // launched preset. Separate from the provider writer above because an external
  // agent is not a chat provider — sharing that record would make a Claude Code
  // pick rewrite the built-in Anthropic model. Same swallow-on-failure contract.
  const persistBackendModelFn = useCallback(
    (presetId: string, modelId: string): boolean => {
      try {
        if (persistBackendModel) return persistBackendModel(presetId, modelId)
        setAgentBackendModel(home, presetId, modelId)
        return true
      } catch {
        return false
      }
    },
    [home, persistBackendModel]
  )

  // Write a provider credential (api key / subscription token) to
  // `~/.cognia/credentials.json` when the `/provider` key prompt is submitted.
  // Failures (read-only home) return false so the prompt surfaces the error
  // inline instead of the App throwing.
  const persistCredentialFn = useCallback(
    (providerId: string, secret: string, kind: CredentialKind): boolean => {
      try {
        if (persistCredential) return persistCredential(providerId, secret, kind)
        setCredential(home, providerId, secret, undefined, { kind })
        return true
      } catch {
        return false
      }
    },
    [home, persistCredential]
  )

  // Resolve a plan-approval choice (Claude Code parity — the execution mode is
  // chosen at approval time):
  //   - approve-auto / approve-confirm: switch to a build mode (acceptEdits /
  //     default) and implement IN CONTEXT (the plan above is still visible).
  //   - approve-new-session: mint a FRESH session (clean context), switch to
  //     acceptEdits, and inject the plan text (reloaded from disk so any
  //     "Edit plan first" revisions are honoured). The leading plan title
  //     auto-names the run in the sessions list.
  //   - edit-then-approve: open the saved plan in $EDITOR and KEEP the overlay
  //     open so the user can revise, then approve.
  //   - keep: close and stay in plan mode.
  const onPlanDecision = useCallback(
    (decision: PlanDecision) => {
      const planOverlay = state.overlay.kind === "plan" ? state.overlay : null

      // Edit-first: launch the editor on the saved plan, leave the overlay up.
      if (decision === "edit-then-approve") {
        const file = planOverlay?.savedTo
        if (!file) {
          dispatch({ type: "NOTICE", message: "No saved plan file to edit yet." })
          return
        }
        const { editor } = detectEditor(process.env, { config: state.config.editor })
        void openInEditorFn(file, { editor }).then((ok) =>
          dispatch({
            type: "NOTICE",
            message: ok
              ? `Editing ${file} in ${editor.displayName} — save it, then pick an approve option to run the edited plan.`
              : `Couldn't launch an editor — edit ${file} manually, then approve.`,
          })
        )
        return
      }

      dispatch({ type: "OVERLAY_CLOSE" })
      if (decision === "keep") return

      // Fresh-session execution: clean context, auto-edits, embed the (reloaded)
      // plan so the new session has the full brief.
      if (decision === "approve-new-session") {
        const reloaded = planOverlay?.savedTo ? loadPlanFile(planOverlay.savedTo) : null
        const raw = reloaded ?? planOverlay?.raw ?? ""
        persist("permissionMode", "acceptEdits")
        void (async () => {
          await agent.clear(mintId())
          await agent.switchMode("acceptEdits")
          await agent.send(raw ? PLAN_EXECUTE_PROMPT(raw) : PLAN_APPROVED_PROMPT)
        })()
        return
      }

      const mode = planDecisionMode(decision)
      if (mode) {
        persist("permissionMode", mode)
        // switchMode now mutates the LIVE session in place (no respawn), so the
        // proposed plan above is still in context when we tell the agent to
        // implement it. Await the mode switch before sending so the build-mode
        // gate is active for the implementation turn.
        void (async () => {
          await agent.switchMode(mode)
          await agent.send(PLAN_APPROVED_PROMPT)
        })()
      }
    },
    [agent, persist, state.overlay, state.config.editor, openInEditorFn, loadPlanFile, mintId]
  )

  const openSessions = useCallback(() => {
    const fsRead: ReadDir = readdir ?? ((dir) => fs.readdirSync(dir))
    const items = listSessions(home, { readdir: fsRead, transcriptFs })
    if (items.length === 0) {
      dispatch({ type: "NOTICE", message: "No past sessions found." })
      return
    }
    dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "sessions", items, index: 0 } })
  }, [home, readdir, transcriptFs])

  const doResume = useCallback(
    (id: string) => {
      const cells = transcriptToCells(readTranscript(home, id, transcriptFs))
      void agent.resume(id, cells)
    },
    [agent, home, transcriptFs]
  )

  // Resume the most-recently-active session directly (the `/resume` command),
  // reusing the same session-list + resume path the `/sessions` browser uses.
  const resumeMostRecent = useCallback(() => {
    const fsRead: ReadDir = readdir ?? ((dir) => fs.readdirSync(dir))
    const items = listSessions(home, { readdir: fsRead, transcriptFs })
    if (items.length === 0) {
      dispatch({ type: "NOTICE", message: "No past sessions to resume." })
      return
    }
    doResume(items[0].sessionId)
  }, [doResume, home, readdir, transcriptFs])

  // Resume a specific session by id (`/resume <id>` / `--resume <id>`). Validated
  // against the session store so a typo'd id yields a notice, not an empty session.
  const resumeSession = useCallback(
    (id: string) => {
      const fsRead: ReadDir = readdir ?? ((dir) => fs.readdirSync(dir))
      const items = listSessions(home, { readdir: fsRead, transcriptFs })
      const match = items.find((s) => s.sessionId === id)
      if (!match) {
        dispatch({ type: "NOTICE", message: `No session "${id}" — /sessions to browse.` })
        return
      }
      doResume(match.sessionId)
    },
    [doResume, home, readdir, transcriptFs]
  )

  // Interpret a pure CommandEffect produced by the dispatcher — see useApplyEffect.
  const applyEffect = useApplyEffect({
    agent,
    dispatch,
    state,
    home,
    osHome,
    mintId,
    clearScreen,
    scrollReset,
    cursor,
    copyClipboard,
    notices,
    pushHandoff,
    attachHost,
    detachHost,
    hostSyncStatus,
    openSessions,
    openModelPicker,
    resumeMostRecent,
    resumeSession,
    runBash,
    killBash,
    foregroundBash,
    takeLastFailedBash,
    persistStatusBar,
    persistMascot,
    persistEditor,
    openInEditorFn,
    runShell,
    persist,
    persistDb,
    fullscreen,
    screen,
    selectionRef,
    startGoalRun,
    startLoopRun,
    startFixRun,
    syncAndRefreshModelOverlay,
    takeSteer,
    doExit,
    changeCwd,
    reclaimBackend,
    setRuntimeAbort,
    getRuntimeAbort,
    mcpProbeCache,
    sessionOnlyPermissionMode,
  })

  // Ctrl+click "smart action at point" needs two capabilities the resolver
  // deliberately doesn't own: whether a path-shaped token is a real file, and
  // how to open it. Both route through the existing editor plumbing, so a click
  // and `/open` behave identically.
  const fileExists = useCallback(
    (candidate: string) => {
      try {
        const abs = nodePath.isAbsolute(candidate)
          ? candidate
          : nodePath.resolve(state.config.cwd, candidate)
        return fs.statSync(abs).isFile()
      } catch {
        return false
      }
    },
    [state.config.cwd]
  )
  const openFileAt = useCallback(
    (file: string, line?: number, col?: number) => {
      applyEffect({
        kind: "openFile",
        file,
        ...(line === undefined ? {} : { line }),
        ...(col === undefined ? {} : { col }),
      })
    },
    [applyEffect]
  )

  const runCommandLine = useCallback(
    (line: string) => {
      applyEffect(
        dispatchCommand(line, { state, config: state.config, version: VERSION, args: "" })
      )
    },
    [applyEffect, state]
  )

  // Recovery actions on the connect-failure page. Defined after `runCommandLine`
  // so the `/doctor` route can reuse the normal command path.
  const onBackendFailureAction = useCallback(
    (action: BackendFailureAction) => {
      const backend = liveConfigRef.current.agentBackend ?? "builtin"
      if (action === "install") {
        const option = installOptionRef.current
        // Belt-and-braces: the choice only exists when an option is present, but
        // a stale keypress must never spawn nothing.
        if (!option) return
        dispatch({
          type: "BACKEND_INSTALL_START",
          name: option.name,
          display: option.method.display,
          // Carried so the page can say whether Cognia will own what this
          // installs. Every current method is a handoff to the user's own
          // package manager.
          ownership: option.method.ownership,
        })
        const run = runInstallFn ?? defaultRunInstall
        const controller = new AbortController()
        installAbortRef.current = controller
        void run({
          method: option.method,
          onLine: (line) => dispatch({ type: "BACKEND_INSTALL_OUTPUT", chunk: `${line}\n` }),
          signal: controller.signal,
        }).then((result) => {
          if (installAbortRef.current === controller) installAbortRef.current = null
          if (controller.signal.aborted) return
          if (result.ok) {
            // The binary is now on PATH — re-enter the connect flow, which
            // re-probes and proceeds to the handshake.
            dispatch({ type: "BACKEND_CONNECT_RETRY", backend })
          } else {
            const exit = result.exitCode === null ? "" : ` (exit ${result.exitCode})`
            dispatch({
              type: "BACKEND_INSTALL_FAIL",
              message: `Couldn't install ${option.name}${exit} — try \`${option.method.display}\` manually.`,
            })
          }
        })
        return
      }
      if (action === "retry") {
        dispatch({ type: "BACKEND_CONNECT_RETRY", backend })
        return
      }
      if (action === "quit") {
        doExit()
        return
      }
      // Both remaining routes land in the chat on the built-in agent. Falling
      // back is stated outright rather than applied quietly — a user who is not
      // told would keep believing the agent they asked for is answering.
      dispatch({ type: "SET_BACKEND", backend: "builtin" })
      dispatch({ type: "STARTUP_TRUST" })
      dispatch({
        type: "NOTICE",
        message: `Switched to the built-in agent — ${backend} could not start.`,
      })
      if (action === "doctor") runCommandLine("/doctor")
    },
    [doExit, runCommandLine, runInstallFn]
  )

  const cancelBackendInstall = useCallback(() => {
    installAbortRef.current?.abort()
    installAbortRef.current = null
    dispatch({ type: "BACKEND_INSTALL_CANCEL" })
  }, [])

  // Launch-flag command (`--continue` / `--resume [id]`): run exactly once, and
  // only after the startup trust gate has cleared — resuming a session while
  // the gate is up would fight the gate's own phase transition.
  const initialCommandRanRef = useRef(false)
  useEffect(() => {
    if (!initialCommand || initialCommandRanRef.current) return
    if (state.phase !== "chat") return
    initialCommandRanRef.current = true
    runCommandLine(initialCommand)
  }, [initialCommand, state.phase, runCommandLine])

  // Startup acknowledgement for a session that OPENS with no guardrails —
  // `--bypass` on the command line, or a `permissionMode` persisted in config.
  // A launch flag is an intent, not informed consent: the composer must not
  // accept its first message while every approval gate is silently disarmed.
  // Runs once, after the trust gate has cleared (same reason as the launch
  // command above), and declining de-escalates the session rather than leaving
  // it armed — see `startupBypassConfirmOverlay`.
  const bypassGateShownRef = useRef(false)
  useEffect(() => {
    if (bypassGateShownRef.current) return
    if (state.phase !== "chat" || state.bypassAcknowledged) return
    if (!requiresAcknowledgement(state.config.permissionMode)) return
    bypassGateShownRef.current = true
    dispatch({
      type: "OVERLAY_OPEN",
      overlay: startupBypassConfirmOverlay(state.config.permissionMode),
    })
  }, [state.phase, state.bypassAcknowledged, state.config.permissionMode])

  // Resolve `@skill:` / `@agent:` mentions in a submitted line before it is sent:
  // enable + persist mentioned skills, synchronously dispatch mentioned agents and
  // fold their output into the prompt, and strip the tokens. Reuses the same
  // skill/agent discovery the `/skill` + `/agents` controllers use. Returns the
  // rewritten prompt and the ids of any skills enabled (so the caller can
  // invalidate the cached SendOptions for the next turn).
  const runMentionPreprocess = useCallback(
    (text: string) =>
      preprocessMentions(text, {
        setSkillEnabled: (id) => {
          if (persistSkillEnabled) {
            persistSkillEnabled(id)
            return
          }
          skillSetEnabled(id, true, {
            dispatch,
            home,
            cwd: state.config.cwd,
            osHome,
            externalSkills: state.config.externalSkills,
            skillDirs: state.config.skillDirs,
          })
        },
        dispatchAgent: async (id, prompt) => {
          const agents = buildAgents(await discoverAgentFiles([state.config.cwd, home]))
          const match = agents.find((a) => a.id === id)
          if (!match) return { text: `subagent "${id}" not found`, ok: false }
          dispatch({
            type: "ACTIVITY_START",
            kind: "agent",
            label: `${id}: ${prompt}`.slice(0, 60),
          })
          try {
            const result = await dispatchSubagent(match.def, prompt, { cwd: state.config.cwd })
            dispatch({ type: "ACTIVITY_END", status: "done", summary: `Subagent "${id}" done` })
            return { text: result.text, ok: true }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            dispatch({ type: "ACTIVITY_END", status: "error", summary: `Subagent "${id}" failed` })
            return { text: message, ok: false }
          }
        },
        notice: (message) => dispatch({ type: "NOTICE", message }),
        // Map every accepted `@skill:` token (the friendly slug the popup inserts
        // AND the raw id, for back-compat) to the real Dexie id to enable.
        skillIdsByToken: async () => {
          const map = new Map<string, string>()
          for (const c of await mentionProviders.skills("")) {
            if (c.slug) map.set(c.slug, c.id)
            map.set(c.id, c.id)
          }
          return map
        },
        knownAgentIds: async () => new Set((await mentionProviders.agents("")).map((c) => c.id)),
      }),
    [
      mentionProviders,
      home,
      osHome,
      state.config.cwd,
      state.config.externalSkills,
      state.config.skillDirs,
      persistSkillEnabled,
    ]
  )

  // Send a plain message, then deliver any `btw` steer typed while it streamed
  // as follow-up turns — so a steer never interrupts the turn it was typed
  // during. Stops if a goal/loop run takes over (that driver owns the drain).
  const sendThenDrainSteer = useCallback(
    async (text: string) => {
      // Resolve @-mentions first: enable skills, run agents, rewrite the prompt.
      const { prompt, enabledSkills } = await runMentionPreprocess(text)
      // A newly-enabled skill must take effect next turn — drop the cached
      // SendOptions so they re-resolve with the updated ephemeralSkillIds.
      if (enabledSkills.length > 0) agent.invalidate()
      await agent.send(prompt)
      let steer = takeSteer()
      while (steer !== null && runtimeAbort.current === null) {
        await agent.send(frameSteer(steer))
        steer = takeSteer()
      }
    },
    [agent, takeSteer, runMentionPreprocess]
  )

  // In copilot mode a plain message goes to the workflow-editor session; after
  // the turn, surface any newly-staged proposal as an Apply/Discard overlay.
  const sendCopilot = useCallback(
    async (workflowId: string, text: string) => {
      await agent.send(text)
      copilotCheckProposal(workflowId, { dispatch })
    },
    [agent]
  )

  const handleSubmit = useCallback(
    (text: string) => {
      // Re-pin the fullscreen viewport to the bottom on any submit, so sending a
      // message always snaps back to the live turn even if the user had scrolled
      // up to read history. No-op in scrollback mode.
      scrollReset()
      // Editing a prior message: fork the conversation at the target (drop it and
      // every later turn), then send the edited text as a fresh turn. Only a plain
      // message edits — submitting a `/command` or `!bash` instead abandons the
      // pending edit (clear the target so its stale index can't fork a later send).
      const editTarget = state.editTarget
      if (editTarget) {
        if (!text.startsWith("/") && parseBang(text) === null) {
          const cells = state.cells
          void (async () => {
            await agent.forkConversationAt(editTarget.index, cells)
            dispatch({
              type: "NOTICE",
              message:
                "Edited and re-ran from here. Earlier file changes were not reverted — use /rewind both to restore.",
            })
            await sendThenDrainSteer(text)
          })()
          return
        }
        dispatch({ type: "EDIT_CLEAR" })
      }
      // `# fact` quick-captures a memory (Claude Code parity) instead of sending
      // to the model — reuses /remember (→ memory add). Checked before bang/slash.
      const memo = parseHashMemory(text)
      if (memo !== null) {
        runCommandLine(`/remember ${memo}`)
        return
      }
      const bang = parseBang(text)
      if (bang !== null) {
        runBash(bang)
        return
      }
      // A plain line submitted while a foreground `!command` holds the terminal
      // is input for that command's stdin (a `y/n`, a passphrase), not a model
      // message. To steer the model instead, background the run first (Ctrl+B).
      if (!text.startsWith("/") && hasForegroundRun() && sendInputToForeground(text)) {
        return
      }
      if (!text.startsWith("/")) {
        // A message typed while a turn or a goal/loop run is in flight becomes a
        // `btw` steer: queued and delivered at the next turn boundary so it never
        // interrupts the running turn.
        if (busy || runtimeAbort.current !== null) {
          dispatch({ type: "STEER_ENQUEUE", text })
          dispatch({
            type: "NOTICE",
            message: "💬 Queued (btw) — will steer the run at the next turn boundary.",
          })
          return
        }
        // Copilot mode routes free-text to the workflow-editor session.
        const copilotWf = state.copilot?.workflowId
        if (copilotWf) {
          void sendCopilot(copilotWf, text)
          return
        }
        void sendThenDrainSteer(text)
        return
      }
      runCommandLine(text)
    },
    [
      busy,
      runBash,
      runCommandLine,
      sendThenDrainSteer,
      sendCopilot,
      hasForegroundRun,
      sendInputToForeground,
      state.copilot?.workflowId,
      state.editTarget,
      state.cells,
      agent,
      scrollReset,
    ]
  )

  const submitForm = useCallback(() => {
    if (state.overlay.kind !== "form") return
    const form = state.overlay.form
    const result = formSubmit(form)
    if (!result.ok) {
      dispatch({ type: "FORM_UPDATE", form: result.form })
      return
    }
    dispatch({ type: "OVERLAY_CLOSE" })
    const sub = form.subcommand ? ` ${form.subcommand}` : ""
    runCommandLine(`/${form.commandName}${sub} ${result.args}`.trim())
  }, [state.overlay, runCommandLine])

  // Apply an inline settings-panel edit (enum cycle / boolean toggle): persist
  // via the matching mutate helper, live-merge the config, then RE-OPEN the panel
  // so the new value shows immediately (the panel snapshot is rebuilt from the
  // post-edit config). Nested objects are pre-merged here so SET_CONFIG_PATCH can
  // stay a shallow merge. Tool/flag/hook/output edits invalidate the cached
  // SendOptions so the next turn picks them up; theme/mascot are display-only.
  const applySettings = useCallback(
    (target: SettingsApplyTarget, value: string | boolean) => {
      const cfg = state.config
      let patch: Partial<ResolvedConfig> = {}
      let invalidate = false
      try {
        switch (target.kind) {
          case "theme":
            patch = { theme: String(value) }
            setConfigValue(home, "theme", String(value))
            break
          case "outputStyle":
            patch = { outputStyle: value as OutputStyle }
            setConfigValue(home, "outputStyle", String(value))
            invalidate = true
            break
          case "statusTheme":
            patch = { statusBar: { ...cfg.statusBar, theme: value as StatusTheme } }
            setStatusBarConfig(home, { theme: value as StatusTheme })
            break
          case "mascotEnabled":
            patch = { mascot: { ...cfg.mascot, enabled: Boolean(value) } }
            setMascotConfig(home, { enabled: Boolean(value) })
            break
          case "mascotStyle":
            patch = { mascot: { ...cfg.mascot, style: value as MascotStyle } }
            setMascotConfig(home, { style: value as MascotStyle })
            break
          case "flag":
            patch = { [target.key]: Boolean(value) } as Partial<ResolvedConfig>
            setBooleanFlag(home, target.key, Boolean(value))
            invalidate = true
            break
          case "configValue":
            patch = { [target.key]: String(value) } as Partial<ResolvedConfig>
            setConfigValue(home, target.key, String(value))
            invalidate = true
            break
          case "numberValue": {
            // Arrives as a string from an enum row; the schema stores a number.
            const num = Number(value)
            patch = { [target.key]: num } as Partial<ResolvedConfig>
            setNumberConfig(home, target.key, num)
            invalidate = true
            break
          }
          case "clipboard": {
            // osc52 is a string mode; osc52MaxBytes a number. Read live at copy
            // time from state.config, so no SendOptions invalidation needed.
            const clipPatch = (
              target.key === "osc52" ? { osc52: String(value) } : { osc52MaxBytes: Number(value) }
            ) as ClipboardConfig
            patch = { clipboard: { ...cfg.clipboard, ...clipPatch } }
            setClipboardConfig(home, clipPatch)
            break
          }
          case "builtinTool":
            patch = { builtinTools: { ...cfg.builtinTools, [target.key]: Boolean(value) } }
            setBuiltinTools(home, { [target.key]: Boolean(value) } as Partial<BuiltinToolsConfig>)
            invalidate = true
            break
          case "gitWorkflow": {
            // ON restores the default trailer/footer text (clears the key so the
            // resolver's default applies); OFF stores an explicit `false`.
            // Read live by the /commit and /pr controllers — no SendOptions
            // invalidation needed.
            const gitPatch = { [target.key]: value === true ? undefined : false }
            patch = { git: { ...cfg.git, ...gitPatch } }
            setGitWorkflowConfig(home, gitPatch)
            break
          }
          case "logging": {
            // fileLevel is a string enum; the rotation sizes are numbers. Read
            // live by the log-file writers — no SendOptions invalidation needed.
            const logPatch = (
              target.key === "fileLevel"
                ? { fileLevel: String(value) }
                : { [target.key]: Number(value) }
            ) as CliLoggingConfig
            patch = { logging: { ...cfg.logging, ...logPatch } }
            setLoggingConfig(home, logPatch)
            break
          }
          case "hook":
            patch = {
              builtinHookOverrides: { ...cfg.builtinHookOverrides, [target.id]: Boolean(value) },
            }
            setBuiltinHookOverride(home, target.id, Boolean(value))
            invalidate = true
            break
          case "render": {
            // Numeric prefs arrive as a string from an enum row; booleans as a
            // boolean from a toggle. Display-only — no SendOptions invalidation.
            const rawValue = NUMERIC_RENDER_KEYS.has(target.key) ? Number(value) : Boolean(value)
            patch = { render: { ...cfg.render, [target.key]: rawValue } }
            setRenderConfig(home, { [target.key]: rawValue })
            break
          }
        }
      } catch {
        dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
      }
      dispatch({ type: "SET_CONFIG_PATCH", patch })
      if (invalidate) agent.invalidate()
      const ov = state.overlay
      const section = ov.kind === "settings" ? ov.section : 0
      const index = ov.kind === "settings" ? ov.index : 0
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "settings",
          sections: settingsSections({ ...cfg, ...patch }, state.backendCapabilities),
          section,
          index,
        },
      })
      // A theme change from the settings panel recolours the palette, but in
      // scrollback mode the committed transcript + banner live inside `<Static>`,
      // which never repaints in place — clear + bump the render epoch so they
      // re-print with the new colours (mirrors the `/theme` command path).
      if (target.kind === "theme" && !fullscreen) {
        clearScreen()
        dispatch({ type: "REPAINT" })
      }
    },
    [state.config, state.overlay, state.backendCapabilities, home, agent, clearScreen, fullscreen]
  )

  // Enter on a delegate/form settings row: delegate rows run the existing slash
  // command (opening its overlay); form rows open a single-/multi-field editor.
  const activateSettings = useCallback(
    (row: SettingsRow) => {
      const c = row.control
      if (c.type === "delegate") {
        if (c.command === "/provider" && state.overlay.kind === "settings") {
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: {
              kind: "provider",
              options: collectProviderOptions(state.config),
              index: 0,
              query: "",
              returnToSettings: {
                section: state.overlay.section,
                index: state.overlay.index,
              },
            },
          })
          return
        }
        runCommandLine(c.command)
        return
      }
      if (c.type === "credential" && state.overlay.kind === "settings") {
        const provider = collectProviderOptions(state.config).find(
          (option) => option.id === state.config.provider
        )
        if (!provider) return
        const current = state.config.providers[provider.id]
        const credentialKind = current?.authToken && !current.apiKey ? "authToken" : "apiKey"
        const secret = current?.[credentialKind] ?? ""
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "providerKey",
            providerId: provider.id,
            providerName: provider.name,
            credentialKind,
            value: secret,
            reveal: false,
            ...(secret ? { existing: true } : {}),
            ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}),
            returnToSettings: {
              section: state.overlay.section,
              index: state.overlay.index,
            },
          },
        })
        return
      }
      if (c.type !== "form") return
      if (c.field === "customTheme") {
        runCommandLine("/theme custom")
        return
      }
      const cfg = state.config
      let current = ""
      if (c.field === "systemPrompt") current = cfg.systemPrompt ?? ""
      else if (c.field === "skillDirs") current = (cfg.skillDirs ?? []).join(" ")
      else if (c.field === "allowedTools") current = (cfg.allowedTools ?? []).join(" ")
      else if (c.field === "gitProtectedBranches")
        current = resolveGitWorkflowConfig(cfg.git).protectedBranches.join(" ")
      else if (c.field === "gitBaseBranch") current = cfg.git?.baseBranch ?? ""
      applyEffect({
        kind: "openForm",
        form: {
          title: `Edit ${c.field}`,
          commandName: "settings",
          subcommand: c.field,
          specs: [
            {
              name: "value",
              label: c.field,
              type: "string",
              style: "positional",
              default: current,
            },
          ],
        },
      })
    },
    [state.config, state.overlay, runCommandLine, applyEffect]
  )

  // `/agents models` panel edit: persist one subagent's provider/model override
  // (or clear it on `null`), patch the live config, invalidate the session so the
  // next dispatch picks up the change, and reopen the panel with rows recomputed
  // against the new config (cursor index preserved). Mirrors `applySettings`.
  const applySubagentModelEdit = useCallback(
    (agentId: string, override: SubagentModelOverride | null) => {
      const ov = state.overlay
      if (ov.kind !== "subagentModels") return
      const nextMap = { ...(state.config.subagentModels ?? {}) }
      if (override === null) delete nextMap[agentId]
      else nextMap[agentId] = override
      const subagentModels = Object.keys(nextMap).length > 0 ? nextMap : undefined
      const patch: Partial<ResolvedConfig> = { subagentModels }
      try {
        setSubagentModel(home, agentId, override)
      } catch {
        dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
      }
      dispatch({ type: "SET_CONFIG_PATCH", patch })
      agent.invalidate()
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "subagentModels",
          rows: recomputeSubagentModelRows(ov.rows, { ...state.config, ...patch }),
          index: ov.index,
        },
      })
    },
    [state.overlay, state.config, home, agent]
  )

  // Reverse-history-search handlers. The pure `searchHistory` matcher scans the
  // composer history (oldest-first); `fromIndex = entries.length` finds the most
  // recent match, and passing the last hit's index cycles to the next-older one.
  // Refining the query always restarts from the most-recent end.
  const applyHistorySearch = useCallback(
    (query: string, fromIndex: number) => {
      const hit = searchHistory(state.input.history.entries, query, fromIndex)
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "historySearch",
          query,
          match: hit ? hit.match : null,
          // Keep the cursor where it was so a no-match Ctrl+R doesn't reset the
          // cycle to the top; on a hit, advance to the hit so the next Ctrl+R
          // continues older.
          matchIndex: hit ? hit.index : fromIndex,
        },
      })
    },
    [state.input.history.entries]
  )

  // Ctrl+V: read an image off the OS clipboard and append it as an `@<path>`
  // mention into the composer, so it flows through the existing attachment
  // pipeline (the same `@file` mechanism a typed path uses). A missing image
  // surfaces a notice rather than failing silently.
  const pasteClipboardImage = useCallback(async () => {
    const result = await readClipboardImage()
    if (!result) {
      dispatch({ type: "NOTICE", message: "No image in clipboard" })
      return
    }
    const buffer = state.input.buffer
    const sep = bufferText(buffer).length > 0 ? " " : ""
    dispatch({ type: "INPUT_SET", buffer: insertText(buffer, `${sep}@${result.path}`) })
    dispatch({ type: "NOTICE", message: "📎 image from clipboard" })
  }, [readClipboardImage, state.input.buffer])

  const abortRuntime = useCallback(() => {
    if (runtimeAbort.current) {
      runtimeAbort.current.abort()
      runtimeAbort.current = null
    }
  }, [])

  // Resolve a permission prompt. On "Allow always", persist the tool so it never
  // prompts again (the desktop's always-allow store, ported to the CLI) and
  // invalidate the cached SendOptions so the next turn re-resolves with it.
  const resolvePermission = useCallback(
    (decision: CapturePermissionDecision) => {
      if (
        !attachedHostConnectionRef.current &&
        decision.decision === "allow_always" &&
        state.overlay.kind === "permission"
      ) {
        const toolName = state.overlay.req.toolName
        try {
          persistToolApproval(home, toolName)
        } catch {
          // best-effort — a read-only home shouldn't break the turn.
        }
        // Add to the live set so later calls THIS session auto-approve silently
        // (invalidate only re-resolves options on the NEXT session respawn, so
        // without this the same tool keeps prompting for the rest of the turn).
        agent.rememberApproval(toolName)
        agent.invalidate()
      }
      agent.resolvePermission(decision)
    },
    [agent, home, persistToolApproval, state.overlay]
  )

  // Global key handler: Ctrl+C ladder, find-in-viewport, backtrack-to-edit,
  // fullscreen scroll/mouse routing, chord actions, Shift+Tab, double-Esc.
  useGlobalKeys({
    state,
    dispatch,
    overlayOpen,
    busy,
    fullscreen,
    mouseMode,
    selectionMode,
    selection: selectionRef,
    screenRows: () => frames?.plain() ?? [],
    fileExists,
    openFileAt,
    notices,
    keybindings,
    renderPrefs,
    now,
    doExit,
    cancelBackendConnect,
    cancelBackendInstall,
    agent,
    abortRuntime,
    askUser,
    hasForegroundRun,
    killForegroundBash,
    backgroundForegroundBash,
    copyClipboard,
    runCommandLine,
    openModelPicker,
    pasteClipboardImage,
    scrollReset,
    disarmBacktrack,
    armBacktrack,
    cursor,
    scroll,
    clearScreen,
    composerPopupOpen,
    subagentChipRef,
    agentTreeRef,
    footerRowRef,
    footerSegmentsRef,
    scrollContentRef,
    backtrackArmedRef,
  })

  // Identity line: on an external backend the built-in provider/model would be
  // an outright lie — that agent is not what answers — so the backend and the
  // model it reported take their place.
  const identity = useMemo(
    () => backendIdentity(state.config, state.backendCapabilities?.presetId),
    [state.config, state.backendCapabilities]
  )
  const banner = useMemo(
    () => (
      // No `?? activeModel` fallback: `identity.model` is absent exactly when we
      // never told the agent which model to use, and substituting the built-in
      // provider's catalog default there is the fabrication `backendIdentity`
      // exists to prevent. Absent renders as no model at all, which is honest.
      <Banner
        version={VERSION}
        provider={identity.provider}
        {...(identity.model ? { model: identity.model } : {})}
        cwd={state.config.cwd}
        density={layoutBudget.bannerDensity}
      />
    ),
    [identity, state.config.cwd, layoutBudget.bannerDensity]
  )
  const lastPlanRaw = state.lastPlan?.raw
  const footerPlanTitle = useMemo(
    () => (lastPlanRaw ? planTitle(lastPlanRaw) : undefined),
    [lastPlanRaw]
  )
  const inflightTools = state.inflight.tools
  const footerSubagentRunning = useMemo(() => runningSubagents(inflightTools), [inflightTools])
  const footerBackgroundSubagents = useMemo(() => {
    void inflightTools
    // Scope to this chat session so the footer counts only the background
    // subagents the current session started (the registry is process-global).
    return countRunningCliBackgroundRuns(state.sessionId)
  }, [inflightTools, state.sessionId])
  const copilotName = state.copilot?.name
  const hasCopilot = state.copilot !== undefined
  const footerCopilot = useMemo(
    () => (hasCopilot ? { name: copilotName ?? "" } : undefined),
    [copilotName, hasCopilot]
  )
  // Timestamp the current turn entered "streaming", for the BottomStatus elapsed
  // timer. Captured in an effect — Date.now() is impure and refs/state must not
  // be touched during render. The deferred set keeps it out of the synchronous
  // effect body; one tick of lag before `since` lands is invisible to the
  // 1s-resolution elapsed timer (BottomStatus renders no elapsed while null).
  const isStreaming = state.turnStatus === "streaming"
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setStreamStartedAt(isStreaming ? Date.now() : null), 0)
    return () => clearTimeout(t)
  }, [isStreaming])

  // Timestamp the last live stream delta, for the BottomStatus stall hint. The
  // reducer bumps `streamSeq` on every text/thinking/tool/usage delta; this
  // effect re-stamps "now" whenever it changes while streaming (mirrors the
  // `since` capture above — deferred set, no impure work during render).
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setLastActivityAt(isStreaming ? Date.now() : null), 0)
    return () => clearTimeout(t)
  }, [isStreaming, state.streamSeq])

  // Every pre-chat phase draws in the SAME shell (see LaunchShell): a fixed
  // banner region, a bounded body, and a hint line the body can never push off.
  // Before this they each replaced the whole layout tree, so in fullscreen the
  // frame collapsed and repainted on every transition, and a long install log or
  // failure message could hide the very rows the user had to act on.
  const launchShell = (body: React.ReactNode, hint?: string) => (
    <ThemeProvider palette={themePalette}>
      <RenderPrefsProvider prefs={renderPrefs}>
        <LaunchShell
          banner={banner}
          {...(hint ? { hint } : {})}
          columns={columns}
          rows={rows}
          fullscreen={fullscreen}
        >
          {body}
        </LaunchShell>
      </RenderPrefsProvider>
    </ThemeProvider>
  )
  const launchBodyRows = launchShellLayout(rows, true).bodyRows

  // Startup phase: the "do you trust this folder?" gate only — no transcript,
  // composer or footer until the user proceeds.
  if (state.phase === "startup") {
    return launchShell(
      <StartupGate
        cwd={state.config.cwd}
        onTrust={trustCwd}
        onChangeCwd={changeCwd}
        listDirs={listDirs}
        width={columns}
        maxRows={launchListRows(launchBodyRows, LAUNCH_LIST_CHROME_ROWS)}
      />
    )
  }

  // The external agent is coming up. The composer stays closed so a message
  // cannot be typed into a backend that may still fail to start.
  if (state.phase === "connecting") {
    return launchShell(
      <BackendConnect
        backend={state.backendConnect?.backend ?? state.config.agentBackend ?? "builtin"}
        stage={state.backendConnect?.stage ?? "preset"}
        width={columns}
      />,
      // The shell owns the cancellation hint, so it stays visible even when the
      // progress line wraps on a narrow terminal.
      "Esc to cancel"
    )
  }

  // The agent's CLI is being installed from the failure page. Like connecting,
  // the composer stays closed — there is nothing to type into yet.
  if (state.phase === "installing" && state.backendInstall) {
    return launchShell(
      <BackendInstall
        install={state.backendInstall}
        width={columns}
        maxRows={launchListRows(launchBodyRows, LAUNCH_LIST_CHROME_ROWS)}
      />,
      "Esc to cancel"
    )
  }

  if (state.phase === "connect-failed" && state.backendFailure) {
    return launchShell(
      <BackendFailure
        backend={state.config.agentBackend ?? "builtin"}
        failure={state.backendFailure}
        installOption={state.backendInstallOption}
        installError={state.backendInstallError}
        index={failureIndex}
        onIndexChange={setFailureIndex}
        onSelect={onBackendFailureAction}
        width={columns}
        maxRows={launchListRows(launchBodyRows, LAUNCH_LIST_CHROME_ROWS)}
      />
    )
  }

  const overlays = (
    <AppOverlays
      state={state}
      dispatch={dispatch}
      agent={agent}
      columns={columns}
      viewportRows={overlayViewportRows}
      activeModel={activeModel}
      home={home}
      resolvePermission={resolvePermission}
      persist={persist}
      persistProviderModelFn={persistProviderModelFn}
      persistBackendModelFn={persistBackendModelFn}
      persistCredentialFn={persistCredentialFn}
      persistPluginTools={persistPluginTools}
      openModelPicker={openModelPicker}
      applySettings={applySettings}
      activateSettings={activateSettings}
      applySubagentModelEdit={applySubagentModelEdit}
      applyHistorySearch={applyHistorySearch}
      doResume={doResume}
      runCommandLine={runCommandLine}
      submitForm={submitForm}
      onPlanDecision={onPlanDecision}
      askUser={askUser}
      mcpPanelDeps={mcpPanelDeps}
      clearLogs={clearLogs}
    />
  )

  return (
    <ThemeProvider palette={themePalette}>
      <RenderPrefsProvider prefs={renderPrefs}>
        <TuiViewportFrame
          columns={columns}
          rows={rows}
          fullscreen={fullscreen}
          overlayOpen={overlayOpen}
          overlayRegionRef={overlayRegionRef}
          transcript={
            <TranscriptRegion
              state={state}
              fullscreen={fullscreen}
              banner={banner}
              identity={identity}
              activeModel={activeModel}
              columns={columns}
              scroll={scroll}
              scrollContentRef={scrollContentRef}
              cursor={cursor}
              mutedColor={themePalette.muted}
              layout={layoutBudget}
            />
          }
          overlays={overlays}
          bottom={
            <BottomRegion
              state={state}
              dispatch={dispatch}
              cursor={cursor}
              overlayOpen={overlayOpen}
              columns={columns}
              popupRows={popupRows}
              composerRows={layoutBudget.composerRows}
              layout={layoutBudget}
              warningColor={themePalette.warning}
              streamStartedAt={streamStartedAt}
              lastActivityAt={lastActivityAt}
              footerSubagentRunning={footerSubagentRunning}
              footerBackgroundSubagents={footerBackgroundSubagents}
              interruptedBackgroundSubagents={interruptedBackgroundSubagents}
              footerCopilot={footerCopilot}
              backtrackArmed={backtrackArmed}
              subagentChipRef={subagentChipRef}
              agentTreeRef={agentTreeRef}
              handleSubmit={handleSubmit}
              handleHistoryPush={handleHistoryPush}
              listDir={listDir}
              mentionProviders={mentionProviders}
              keybindings={keybindings}
              enabledSkillIds={enabledSkillIds}
              toggleSkillEnabled={toggleSkillEnabled}
              handlePopupOpenChange={handlePopupOpenChange}
              localSuggestEnabled={localSuggestEnabled}
              aiComplete={aiComplete}
              suggestDebounceMs={state.config.autosuggest?.debounceMs}
              footerPlanTitle={footerPlanTitle}
              footerRowRef={footerRowRef}
              footerSegmentsRef={footerSegmentsRef}
            />
          }
        />
      </RenderPrefsProvider>
    </ThemeProvider>
  )
}
