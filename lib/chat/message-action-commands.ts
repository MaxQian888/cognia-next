export type MessageActionCommandId =
  | "copy"
  | "share"
  | "copyLink"
  | "quote"
  | "shareCard"
  | "bookmark"
  | "edit"
  | "regenerate"
  | "readAloud"
  | "branch"
  | "truncate"
  | "bringBack"
  | "rerunTemplate"
  | "delete"

export interface MessageActionCommandContext {
  role: "user" | "assistant" | "system"
  hasContent: boolean
  hasSession: boolean
  canEdit?: boolean
  canRegenerate?: boolean
  canReadAloud?: boolean
  canBringBack?: boolean
  /** This turn recorded the template parameters it was written from. */
  canRerunTemplate?: boolean
  canDelete?: boolean
  streaming?: boolean
}

export interface MessageActionCommand {
  id: MessageActionCommandId
  disabled?: boolean
  destructive?: boolean
}

/**
 * Host-owned command availability shared by pointer, keyboard, overflow, and
 * mobile long-press surfaces. Each surface supplies presentation and handlers;
 * this pure model supplies the same command set and safety flags.
 */
export function resolveMessageActionCommands(
  context: MessageActionCommandContext
): MessageActionCommand[] {
  const commands: MessageActionCommand[] = []
  if (context.hasContent) {
    commands.push({ id: "copy" }, { id: "share" }, { id: "quote" }, { id: "shareCard" })
  }
  commands.push({ id: "bookmark" })
  if (context.hasSession) {
    commands.push(
      { id: "copyLink" },
      { id: "branch", disabled: context.streaming },
      { id: "truncate", disabled: context.streaming, destructive: true }
    )
  }
  if (context.role === "user" && context.canEdit) commands.push({ id: "edit" })
  if (context.role === "assistant" && context.canRegenerate) {
    commands.push({ id: "regenerate", disabled: context.streaming })
  }
  if (context.role === "assistant" && context.canReadAloud) commands.push({ id: "readAloud" })
  if (context.canBringBack) commands.push({ id: "bringBack" })
  // Only ever on the user's own turn: the values belong to the question, and
  // offering it on the answer would read as "regenerate", which is a different
  // command sitting two rows above.
  if (context.role === "user" && context.canRerunTemplate) {
    commands.push({ id: "rerunTemplate", disabled: context.streaming })
  }
  if (context.canDelete) commands.push({ id: "delete", destructive: true })
  return commands
}
