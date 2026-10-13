/**
 * Feishu's native `/` command panel for a Lark bot.
 *
 * Feishu (PC 7.70+, mobile 7.71+) lists an app's registered slash commands
 * when a user types `/` in a chat with its bot, and posts the chosen command
 * back as an ordinary text message. So the panel needs no handler of its own:
 * every command it offers is one `commands/dispatch.ts` already answers. What
 * it needs is the list, which lives on Feishu per app and is written through
 * `/open-apis/application/v7/app_slash_commands`.
 *
 * {@link syncLarkSlashCommands} makes that list match the control-command
 * registry: it creates what is missing and rewrites a description or icon
 * that drifted. A command it did not put there is left alone, so an operator
 * may register their own next to ours. The adapter runs it on every start
 * (`index.ts`), best effort: without the `application:app_slash_command:read`
 * and `:write` scopes Feishu refuses it, and the bot works exactly as before,
 * typed commands included.
 *
 * Reference: open.feishu.cn/document/mcp_open_tools/agent-best-practices/
 * agent-supports-slash-commands (create/list/PATCH/DELETE, `command` without
 * the slash, `description.default_value` required, 100 commands per app, a
 * client-side delay of a few minutes before a change shows).
 */

import { CONTROL_COMMAND_SPECS, type ControlCommandName } from "@/lib/connectors/commands/registry"
import { COMMAND_DESCRIPTIONS } from "@/lib/connectors/commands/render"
import { classifyScopeError } from "./http"

export const LARK_SLASH_COMMANDS_PATH = "/application/v7/app_slash_commands"
export const LARK_SLASH_READ_SCOPE = "application:app_slash_command:read"
export const LARK_SLASH_WRITE_SCOPE = "application:app_slash_command:write"

/** One icon per command, from the documented `icon_key` list. */
const ICONS: Record<ControlCommandName, string> = {
  help: "promptword_outlined",
  commands: "toolbar-more-ai_outlined",
  status: "diagnosis-ai_outlined",
  sessions: "chat-ai_outlined",
  dir: "folder_outlined",
  new: "add-chat-ai_outlined",
  switch: "ai-trans-switch_outlined",
  resume: "waiting_outlined",
  mode: "ai-style_outlined",
  model: "ai-agent_outlined",
  reasoning: "ai-deepthink_outlined",
  character: "member_outlined",
  team: "robot_outlined",
  workflow: "dynamic-layout_outlined",
  agent: "ai-functions_outlined",
  goal: "flag_outlined",
  tasks: "calendar-line_outlined",
  schedule: "ai-reminder_outlined",
  handoff: "raisehand_outlined",
  delegate: "sent_outlined",
}

export interface LarkSlashCommandDescription {
  default_value: string
  i18n: { zh_cn: string; en_us: string }
  icon: { icon_key: string }
}

export interface LarkSlashCommand {
  /** The command word, without the slash. */
  command: string
  description: LarkSlashCommandDescription
}

/** What Feishu should list: every control command, described in both languages. */
export function larkSlashCommandManifest(): LarkSlashCommand[] {
  return CONTROL_COMMAND_SPECS.map((spec) => {
    const { zh, en } = COMMAND_DESCRIPTIONS[spec.name]
    return {
      command: spec.name,
      description: {
        default_value: zh,
        i18n: { zh_cn: zh, en_us: en },
        icon: { icon_key: ICONS[spec.name] },
      },
    }
  })
}

/**
 * An item `GET app_slash_commands` returns. The documented response puts the
 * icon beside the description, while create and PATCH take it inside; either
 * is read.
 */
interface RegisteredLarkSlashCommand {
  command_id?: string
  command?: string
  description?: {
    default_value?: string
    i18n?: { zh_cn?: string; en_us?: string }
    icon?: { icon_key?: string }
  }
  icon?: { icon_key?: string }
}

export type LarkSlashRequest = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
) => Promise<unknown>

export interface LarkSlashSyncResult {
  created: string[]
  updated: string[]
  unchanged: string[]
  failed: Array<{ command: string; reason: string }>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function matches(registered: RegisteredLarkSlashCommand, wanted: LarkSlashCommand): boolean {
  const description = registered.description
  return (
    description?.default_value === wanted.description.default_value &&
    description?.i18n?.zh_cn === wanted.description.i18n.zh_cn &&
    description?.i18n?.en_us === wanted.description.i18n.en_us &&
    (registered.icon?.icon_key ?? description?.icon?.icon_key) === wanted.description.icon.icon_key
  )
}

/**
 * Bring the app's registered slash commands in line with
 * {@link larkSlashCommandManifest}. Throws when the list itself cannot be read
 * (a missing read scope becomes a `ChatManagementScopeError` naming it). One
 * command Feishu refuses is reported in `failed` and the rest still go
 * through, unless the refusal is the missing write scope, which every other
 * write would hit too.
 */
export async function syncLarkSlashCommands(
  request: LarkSlashRequest,
  manifest: LarkSlashCommand[] = larkSlashCommandManifest()
): Promise<LarkSlashSyncResult> {
  let listed: { data?: { items?: RegisteredLarkSlashCommand[] } } | null
  try {
    listed = (await request("GET", LARK_SLASH_COMMANDS_PATH)) as typeof listed
  } catch (error) {
    throw classifyScopeError(error, LARK_SLASH_READ_SCOPE) ?? error
  }
  const registered = new Map<string, RegisteredLarkSlashCommand>()
  for (const item of listed?.data?.items ?? []) {
    if (item.command) registered.set(item.command, item)
  }

  const result: LarkSlashSyncResult = { created: [], updated: [], unchanged: [], failed: [] }
  for (const wanted of manifest) {
    const existing = registered.get(wanted.command)
    try {
      if (!existing) {
        await request("POST", LARK_SLASH_COMMANDS_PATH, wanted)
        result.created.push(wanted.command)
      } else if (matches(existing, wanted)) {
        result.unchanged.push(wanted.command)
      } else if (existing.command_id) {
        await request(
          "PATCH",
          `${LARK_SLASH_COMMANDS_PATH}/${encodeURIComponent(existing.command_id)}`,
          { description: wanted.description }
        )
        result.updated.push(wanted.command)
      } else {
        result.failed.push({ command: wanted.command, reason: "registered without a command_id" })
      }
    } catch (error) {
      const scope = classifyScopeError(error, LARK_SLASH_WRITE_SCOPE)
      result.failed.push({ command: wanted.command, reason: errorText(scope ?? error) })
      if (scope) break
    }
  }
  return result
}
