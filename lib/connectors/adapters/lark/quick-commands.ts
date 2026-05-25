/**
 * Lark bot-menu (快捷指令) → internal action mapping.
 *
 * Feishu bot menus are configured in the developer console; clicking one fires
 * an `application.bot.menu_v6` event carrying the menu item's `event_key`.
 * Feishu exposes no OpenAPI to create menus, so "registering" a quick command
 * in cognia-next means mapping that `event_key` to an action — a prompt or a
 * slash-command line — that the assistant turn should run.
 */

export type LarkQuickCommandActionType = "prompt" | "slash"

export interface LarkQuickCommand {
  /** The `event_key` configured on the Feishu bot-menu item. */
  eventKey: string
  /** Optional human label shown in settings; also the unmapped-key fallback text. */
  label?: string
  action: {
    type: LarkQuickCommandActionType
    /** Prompt text, or a slash-command line (e.g. "/agenda today"). */
    value: string
  }
}

/** First-match lookup of `eventKey` in the configured quick-command list. */
export function resolveQuickCommand(
  commands: LarkQuickCommand[] | undefined,
  eventKey: string
): LarkQuickCommand | undefined {
  if (!commands || commands.length === 0) return undefined
  return commands.find((c) => c.eventKey === eventKey)
}
