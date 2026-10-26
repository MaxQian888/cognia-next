/**
 * The plugin contract's share of `lib/slash-commands/builtin.ts`, which re-exports these.
 */
import type { ChatStatus, PermissionMode } from "../../stores/chat/chat-store"
import type { SettingsSectionId } from "../../components/settings/settings-nav-config"
import type { SlashCommandResultBlock, SystemMessageBlock } from "./system-blocks"

/** What the dispatcher hands an Action command's handler. */
export interface SlashContext {
  /** Interactive start preview shared by the slash command and one-shot chip. */
  startBestOfN?: (prompt: string, n: 2 | 3 | 4, agents?: string[]) => Promise<boolean>
  isMobile?: boolean
  isAside?: boolean
  /** Cooperative cancellation supplied by the invoking host, when supported. */
  signal?: AbortSignal
  /** Report progress from 0 to 1 with an optional status message. */
  reportProgress?: (progress: number, message?: string) => void

  /** Argument substring after the command name, trimmed. */
  args: string
  /** Currently active session id, if any. */
  activeSessionId: string | null
  /** Status of the active turn. Lets handlers refuse to run mid-stream. */
  chatStatus: ChatStatus
  /** Live read of the active session's permission mode (or null = inherit). */
  currentPermissionMode: PermissionMode | null
  /** Triggers the new-chat flow used by the sidebar's "New" button. */
  startNewSession: () => Promise<void> | void
  /** Open one of the right-rail settings panels. */
  openSettings: (tab: SettingsSectionId) => void
  /** Force a permission mode change (Shift+Tab equivalent). */
  setPermissionMode: (mode: PermissionMode | null) => void
  /**
   * Push a system message into the active session. Accepts markdown (rendered
   * as text — used by /help, /status, …), a structured
   * {@link SystemMessageBlock} that renders as a diagnostics card
   * (/context, /usage, /cost), or a {@link SlashCommandResultBlock} that
   * renders as a compact inline result chip (/resume, …).
   */
  pushSystemMessage: (payload: string | SystemMessageBlock | SlashCommandResultBlock) => void
  /**
   * Files staged in the composer when the command ran, in chip order. Hosts
   * without a composer (the tray, a plugin invoking a command) leave it unset.
   */
  stagedFiles?: readonly SlashStagedFile[]
  /**
   * Take staged files for this command so the turn the composer sends after the
   * batch does not also carry them to the model (`/video` uses an image as the
   * start frame; sending it to the chat model too would be a second, unasked
   * upload). Ids that are not staged are ignored.
   */
  consumeStagedFiles?: (ids: readonly string[]) => void
}

/** A composer attachment as an action command sees it. */
export interface SlashStagedFile {
  id: string
  /** A `blob:` URL owned by the composer; read it before the handler returns. */
  url: string
  mediaType: string
  filename?: string
}

export type SlashScope = "builtin" | "project" | "user" | "plugin"

/** A single parameter the command's guided form collects. */
export interface SlashParamSpec {
  /** Flag/positional key, e.g. `provider` → `--provider <value>`. */
  name: string
  /** User-facing field label. */
  label: string
  /** Input kind. `enum` renders a select from `options`. */
  type: "string" | "enum" | "number" | "boolean"
  /** Required fields block form submission until filled. */
  required?: boolean
  /** Choices for `type: "enum"`. */
  options?: string[]
  /** Pre-filled default value. */
  default?: string
  /** Placeholder for free-text inputs. */
  placeholder?: string
  /**
   * How the value is emitted into the args string:
   *   - `"flag"` (default) → `--name value`
   *   - `"positional"` → bare `value` (order follows the spec list)
   */
  style?: "flag" | "positional"
}

export interface SlashCommand {
  /** Display name without the leading slash. May contain `/` for nested commands. */
  name: string
  description: string
  scope: SlashScope
  /** Hint text rendered next to the name (e.g. "<file>"). */
  argumentHint?: string
  /** Literal first-argument values surfaced by the composer's inline completer. */
  argumentOptions?: string[]
  /** Action handler. When set, picking the command runs it instead of inserting text. */
  handler?: (ctx: SlashContext) => void | Promise<void>
  /** Prompt template inserted into the textarea. Supports `$1..$9` and `$ARGUMENTS`. */
  template?: string
  /** True for items that point at unfinished sidecar features (rendered greyed out). */
  disabled?: boolean
  /** Source file for custom commands (project / user `.claude/commands/...`). */
  filePath?: string
  /** Per-command model override applied to the next send when this template fires. */
  model?: string
  /**
   * Tools the command's body expects to call. Forwarded to SendOptions.allowedTools
   * for the turn that runs this command.
   */
  allowedTools?: string[]
  /** Absolute paths to grant the SDK read access to for this turn. */
  paths?: string[]
  /**
   * When `true`, hide from the user-facing slash-command picker. The command
   * is still loaded and can be referenced programmatically. Mirrors Claude
   * Code's `user-invocable: false` and `disable-model-invocation: true`.
   */
  hiddenFromPicker?: boolean
  /**
   * Grouping key used by surfaces that list commands by section — currently
   * the tray's "All Commands ▶" submenu (`lib/tray/all-commands.ts`).
   * Free-form, but the tray groups by these canonical buckets:
   * `chat | diagnostics | system | goal | template | help | plugins`.
   * Defaults to `"chat"` when omitted.
   */
  category?: string
  /**
   * Optional structured parameters. When present, picking the command opens a
   * guided form (see `components/chat/composer/command-param-form.tsx`) instead
   * of inserting raw text; the collected values are built into the args string
   * via `lib/slash-commands/build-args.ts`.
   */
  params?: SlashParamSpec[]
}
