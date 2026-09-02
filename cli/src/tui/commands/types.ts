/**
 * Command-framework type surface for the interactive TUI.
 *
 * Type-only module (excluded from coverage). The runtime logic that operates on
 * these shapes lives in `registry.ts`, `dispatch.ts`, `help-model.ts`,
 * `arg-hint.ts`, and the form state machine in `../state/form.ts`, each with a
 * co-located test.
 *
 * Design: a command's `handler` is a PURE function of a read-only
 * {@link CommandContext} that returns a {@link CommandEffect} — a serialisable
 * instruction the App interprets. This keeps every handler unit-testable under
 * the pure-`.ts` coverage gate and shrinks `App.tsx` to a thin
 * effect-interpreter that never grows as commands are added.
 */
import type { SlashParamSpec } from "@/lib/slash-commands/builtin"

import type { BooleanFlagKey } from "../../config/mutate"
import type {
  ResolvedConfig,
  StatusBarConfig,
  MascotConfig,
  OutputStyle,
  LayoutMode,
  MouseMode,
  SelectionMode,
} from "../../config/schema"
import type { Overlay, PermissionMode, TuiState } from "../state/types"

/** A guided-form parameter. Identical to the desktop spec so the CLI form reuses
 * `buildArgs` / `firstMissingRequired` verbatim. */
export type CommandArgSpec = SlashParamSpec

/** Grouping buckets shown as sections in `/help` and (optionally) the palette. */
export type CommandCategory =
  "chat" | "session" | "cognia" | "mcp" | "plugin" | "config" | "system" | "custom"

/** A nested verb, e.g. `/goal status` or `/mcp add`. */
export interface SubcommandSpec {
  name: string
  description: string
  /** Structured args this subcommand collects (opens a form when missing). */
  args?: CommandArgSpec[]
  argumentHint?: string
  handler: CommandHandler
}

export interface CommandDescriptor {
  /** Canonical name without the leading slash. */
  name: string
  aliases?: string[]
  description: string
  category: CommandCategory
  /** Structured args for the root command (opens a form when invoked bare). */
  args?: CommandArgSpec[]
  /** Inline usage hint, e.g. `<objective | status | pause>`. */
  argumentHint?: string
  /** Nested verbs. When present, the first token routes to a subcommand. */
  subcommands?: SubcommandSpec[]
  /** Root handler — runs when no subcommand matches (or there are none). */
  handler?: CommandHandler
  /** Keep out of the palette + `/help` (still dispatchable by name). */
  hidden?: boolean
}

/** Read-only snapshot a handler computes its effect from. */
export interface CommandContext {
  state: TuiState
  config: ResolvedConfig
  version: string
  /** Raw argument string after the command (and subcommand) name, trimmed. */
  args: string
}

/**
 * The result of running a command — a declarative effect the App executes.
 * Impure work (network, fs, clipboard, spawning the agent) is named here and
 * performed by the App/hook, so handlers stay pure.
 */
export type CommandEffect =
  | { kind: "none" }
  | { kind: "notice"; message: string }
  | { kind: "openOverlay"; overlay: Overlay }
  | { kind: "openForm"; form: FormRequest }
  | { kind: "send"; prompt: string }
  /** Manually compact the live session's context (`/compact`), both dispatch
   * paths. `focus` is the optional `/compact <focus>` instruction. */
  | { kind: "compact"; focus?: string }
  | { kind: "clear" }
  | { kind: "copy"; text: string }
  | { kind: "handoff" }
  | { kind: "attachHost"; targetId: string; sessionId?: string; accountId?: string }
  | { kind: "detachHost" }
  | { kind: "hostSyncStatus" }
  | { kind: "openSessions" }
  /** Open the `/model` switcher. An effect rather than a ready-made overlay
   * because the option list depends on WHO is answering: an external agent is
   * asked for its own models (async), while the built-in path reads the local
   * catalog. Routing both entry points through one effect keeps `/model` and the
   * keyboard shortcut from drifting apart. */
  | { kind: "modelPicker" }
  | { kind: "resumeLast" }
  /** Resume a specific past session by id (`/resume <id>` / `--resume <id>`). */
  | { kind: "resumeSession"; id: string }
  | { kind: "runBash"; command: string }
  /** Ask the agent to diagnose the last failed `!command` (`/analyze`). The App
   * holds the captured command + output and builds the prompt. */
  | { kind: "analyzeBash" }
  /** Kill a live `!command` run — foreground or backgrounded — by cell id
   * (`/bashes kill`). The App owns the AbortController registry. */
  | { kind: "bashKill"; id: string }
  /** Bring a backgrounded `!command` run back to the foreground (`/bashes fg`)
   * so Ctrl+C / Ctrl+B target it again. */
  | { kind: "bashForeground"; id: string }
  | { kind: "runtime"; runtime: RuntimeRequest }
  /** Persist + live-apply a status-bar customization (`/statusbar`). */
  | { kind: "statusBar"; patch: StatusBarConfig }
  /** Persist + live-apply a mascot customization (`/mascot`). */
  | { kind: "mascot"; patch: MascotConfig }
  /** Persist + live-apply a colour-theme change (`/theme`). Re-resolves the
   * palette so the whole UI recolours in place. */
  | { kind: "theme"; theme: string }
  /** Persist a user-authored custom theme (8 base colours) to
   * `~/.cognia/themes/<slug>.json` and activate it (`/theme custom …`). App
   * writes the file via `setCustomTheme`, then live-applies `custom:<slug>`. */
  | { kind: "customTheme"; base: Record<string, string>; overrides?: Record<string, string> }
  /** Apply a previously file-only field edited from the settings panel
   * (`/settings <field> <value>`): systemPrompt (scalar) or skillDirs /
   * allowedTools (whitespace-split array). App persists + live-merges. */
  | { kind: "settingsSet"; field: string; value: string }
  /** Toggle a top-level boolean config flag (`/route auto on|off` → `autoRoute`).
   * App persists via `setBooleanFlag`, live-merges the patch, and re-resolves
   * SendOptions so the next turn honors it. */
  | { kind: "flag"; key: BooleanFlagKey; value: boolean }
  /** Rebind (or reset) a keyboard chord (`/keybind <action> <spec>`). An empty
   * `spec` resets the action to its default. App persists via `setKeybindings`
   * and live-merges into `config.keybindings`. */
  | { kind: "keybind"; action: string; spec: string }
  /** Persist + live-apply an output-style change (`/output-style`). Re-resolves
   * SendOptions so the next turn uses the new system prompt. */
  | { kind: "outputStyle"; style: OutputStyle }
  /** Switch the session's permission mode (`/mode <name>`). The App routes it
   * through `planPermissionModeSwitch`, so a danger-tier pick opens the
   * acknowledgement confirm instead of applying; `force` IS that acknowledgement
   * (the confirm overlay re-dispatches `/mode <name> --force`) and skips it. */
  | { kind: "permissionMode"; mode: PermissionMode; force?: boolean }
  /** Persist + live-apply an agent-mode change (`/agent-mode <id>`). The mode's
   * prompt / tools / model / permission flow through `resolveSendOptions`; the
   * App persists `config.agentMode` and recreates the session so it takes effect
   * on the next turn. */
  | { kind: "agentMode"; modeId: string }
  /** Persist + live-apply a TUI layout change (`/layout`). The App enters/exits
   * the alternate screen buffer and re-renders the fixed vs scrollback tree. */
  | { kind: "layout"; mode: LayoutMode }
  /** Switch the hosting agent backend: drop the live session and reconnect
   * through the staged startup flow. */
  | { kind: "backend"; backend: string }
  /** Persist + live-apply a fullscreen mouse-mode change (`/mouse`). The App
   * re-applies the terminal mouse tracking/alternate-scroll escapes in place. */
  | { kind: "mouse"; mode: MouseMode }
  /** Persist + live-apply an in-app drag-to-select change (`/select`). The App
   * re-issues the mouse escapes so button-event tracking follows the mode. */
  | { kind: "selection"; mode: SelectionMode }
  /** Start a self-driving goal loop (`/goal <objective>`), streaming each turn
   * into the transcript. status/pause/resume/stop/list stay `runtime` requests. */
  | { kind: "goalRun"; objective: string }
  /** Run `/loop`: `self_paced` lets the model decide when to stop + how long to
   * wait between iterations (reuses `lib/loop`); `interval` re-sends on a fixed
   * cadence. `maxIterations` caps either mode; both stream each turn. */
  | {
      kind: "loop"
      mode: "self_paced" | "interval"
      prompt: string
      intervalMs?: number
      maxIterations?: number
    }
  /** Run `/fix`: a bounded test-fix loop — run `testCommand`, feed failures to the
   * agent, re-run, up to `maxRounds` rounds or until green. Streams each fix turn. */
  | { kind: "fixRun"; testCommand: string; maxRounds: number }
  /** Re-enter plan mode and ask the agent to revise the last plan (`/plan refine`). */
  | { kind: "planRefine" }
  /** Manage `/add-dir` extra working roots (App validates + persists + applies). */
  | { kind: "addDir"; op: "add" | "remove" | "list"; arg: string }
  /** Switch the session working directory (`/cd <dir>`). The App resolves `dir`
   * against the current cwd, validates it is an existing directory, then trusts
   * it + dispatches `SET_CWD` + re-resolves SendOptions so the next turn (and the
   * respawned sidecar) operates there. */
  | { kind: "changeCwd"; dir: string }
  /** Open the `/rewind` checkpoint picker (App reads the live capture). */
  | { kind: "rewindList" }
  /** Restore a checkpoint by seq — files and/or conversation. */
  | { kind: "rewind"; seq: number; scope: "conversation" | "files" | "both" }
  /** Open a file in the external editor (`/open`). App resolves the editor and
   * spawns it, reporting success/failure as a notice. */
  | { kind: "openFile"; file: string; line?: number; col?: number }
  /** Report the detected editor context (`/editor`). App reads `process.env`. */
  | { kind: "editorInfo" }
  /** Persist + live-apply the preferred external editor (`/editor <command>`). */
  | { kind: "setEditor"; command: string }
  /** Show the working-tree git diff (`/diff`) in the scrollable document pager.
   * App shells `git diff` (+ `--staged`) and renders the result. */
  | { kind: "gitDiff" }
  | { kind: "exit" }

/** What `openForm` carries — enough for the App to mount a {@link FormOverlay}. */
export interface FormRequest {
  title: string
  /** The command the form's args are submitted back to. */
  commandName: string
  subcommand?: string
  specs: CommandArgSpec[]
}

/**
 * A request to drive one of the long-running Cognia runtimes (goal / workflow /
 * agent / team). The App routes these to the matching controller in the
 * `runtime` folder; modelled as data so the dispatcher stays pure and testable.
 */
export interface RuntimeRequest {
  feature:
    | "goal"
    | "workflow"
    | "agents"
    | "agentMode"
    | "team"
    | "memory"
    | "mcp"
    | "logs"
    | "plugin"
    | "skill"
    | "export"
    | "doctor"
    | "init"
    | "permissions"
    | "tasks"
    | "status"
    | "limits"
    | "agentStats"
    | "context"
    | "view"
    | "plan"
    | "hooks"
    | "council"
    | "orchestrate"
    | "commit"
    | "pr"
    | "stack"
    | "provider"
  /** Verb within the feature, e.g. "start" | "run" | "list" | "pause". */
  action: string
  /** Free-form argument payload (an id, an objective, etc.). */
  arg?: string
}

/** A handler computes an effect from the context. Pure — no side effects. */
export type CommandHandler = (ctx: CommandContext) => CommandEffect
