/**
 * Single source of truth for the in-chat control-command surface.
 *
 * `parse.ts` derives its KNOWN / READONLY sets from these specs (the grammar
 * and dispatch state machine are untouched), and the Lark integration
 * (plan 2026-07-24 P4.4) uses `nativeExposed` to decide which commands the
 * ops runbook publishes to the platform. Feishu's open platform has NO
 * slash-command registration API for bots — a user-typed "/name" only ever
 * arrives as a plain `im.message.receive_v1` message (verified against the
 * official bot capability overview, 2026-07) — so "native" exposure means
 * bot-menu items configured with 发送文字消息 (V7.22+) that post the command
 * text into the chat, where the existing command dispatcher intercepts it.
 * A deliberately small first batch: platform menus are hard to retract, so
 * exposure is opt-in per command rather than automatic.
 */

export type ControlCommandName =
  | "help"
  | "commands"
  | "status"
  | "sessions"
  | "dir"
  | "new"
  | "switch"
  | "resume"
  | "mode"
  | "model"
  | "reasoning"
  | "character"
  | "team"
  | "workflow"
  | "agent"
  | "goal"
  | "tasks"
  | "schedule"
  | "handoff"
  | "delegate"

export interface ControlCommandSpec {
  name: ControlCommandName
  /** May run without the state-change permission gate. */
  readonly: boolean
  /** Published to the platform-side command manifest (Lark batch 1). */
  nativeExposed: boolean
  /** One-line usage string for help surfaces and the ops runbook manifest. */
  usage: string
}

export const CONTROL_COMMAND_SPECS: readonly ControlCommandSpec[] = [
  { name: "help", readonly: true, nativeExposed: true, usage: "/help" },
  { name: "commands", readonly: true, nativeExposed: false, usage: "/commands" },
  { name: "status", readonly: true, nativeExposed: true, usage: "/status" },
  { name: "sessions", readonly: true, nativeExposed: true, usage: "/sessions" },
  { name: "dir", readonly: true, nativeExposed: false, usage: "/dir" },
  { name: "new", readonly: false, nativeExposed: true, usage: "/new [title]" },
  { name: "switch", readonly: false, nativeExposed: true, usage: "/switch <n|session-id>" },
  { name: "resume", readonly: false, nativeExposed: false, usage: "/resume [session-id]" },
  { name: "mode", readonly: false, nativeExposed: false, usage: "/mode <mode>" },
  { name: "model", readonly: false, nativeExposed: false, usage: "/model <model-id>" },
  { name: "reasoning", readonly: false, nativeExposed: false, usage: "/reasoning <level>" },
  { name: "character", readonly: false, nativeExposed: false, usage: "/character <name>" },
  { name: "team", readonly: false, nativeExposed: false, usage: "/team <name>" },
  { name: "workflow", readonly: false, nativeExposed: false, usage: "/workflow <name>" },
  { name: "agent", readonly: false, nativeExposed: false, usage: "/agent <name>" },
  { name: "goal", readonly: false, nativeExposed: false, usage: "/goal <text>" },
  { name: "tasks", readonly: true, nativeExposed: false, usage: "/tasks" },
  {
    name: "schedule",
    readonly: false,
    nativeExposed: false,
    usage: "/schedule <interval> <prompt> | cron <expr> <prompt> | off <n|id>",
  },
  // Not native-exposed: a bot menu item is a poor fit for a verb that only
  // makes sense while a delegated task is actually running.
  {
    name: "handoff",
    readonly: false,
    nativeExposed: false,
    usage: "/handoff [name] | back [note]",
  },
  // Same reasoning: a menu item for a verb that only means something while
  // work is in flight would be a menu item that usually fails.
  { name: "delegate", readonly: false, nativeExposed: false, usage: "/delegate [title]" },
]

/** Specs published to platform-native slash manifests. */
export function nativeExposedCommands(): readonly ControlCommandSpec[] {
  return CONTROL_COMMAND_SPECS.filter((spec) => spec.nativeExposed)
}

export interface LarkMenuManifestItem {
  /** Menu label shown in the Feishu client. */
  name: string
  /** 发送文字消息 — the literal text the item posts into the chat. */
  actionType: "SEND_MESSAGE"
  text: string
}

/**
 * The bot-menu manifest an operator transcribes into the Feishu developer
 * console. Generated rather than hand-copied: the runbook used to list the
 * batch in prose next to a pointer at this file, so the two drifted the
 * moment a command's `nativeExposed` flag changed.
 *
 * `SEND_MESSAGE` items require client V7.22+; the reserved `cognia.*`
 * push-event items are a separate list (see `quick-commands/built-ins.ts`).
 */
export function larkMenuManifest(): LarkMenuManifestItem[] {
  return nativeExposedCommands().map((spec) => ({
    name: `/${spec.name}`,
    actionType: "SEND_MESSAGE",
    // The command word only — arguments are typed by the user afterwards, so
    // posting the usage string verbatim would send a literal "<n|session-id>".
    text: `/${spec.name}`,
  }))
}
