import { BotIcon, FolderIcon, UsersIcon, type LucideIcon } from "lucide-react"

import type { ConversationGroupAxis } from "@/lib/chat/conversation-list-model"

/**
 * How each conversation-list grouping axis presents itself.
 *
 * The desktop sidebar and the mobile channel list render the model's `group`
 * sections with their own markup but must agree on what a section *means* — an
 * axis that shows a folder icon on one surface and a bot icon on the other is
 * two different features wearing one name. Both surfaces read these maps.
 *
 * The translation keys are bare names on purpose: each surface owns its own
 * namespace (`desktop.channelList` / `mobile.home`) and both define the same
 * three keys, so one map serves both `useTranslations` scopes.
 */

/**
 * Label key for an axis's *ungrouped* bucket.
 *
 * On the team axis that bucket is not "leftovers": it holds every conversation
 * that belongs to no team, i.e. the direct chats, so it borrows the guild
 * rail's own word for them.
 */
export const CONVERSATION_UNGROUPED_LABEL_KEY: Record<ConversationGroupAxis, string> = {
  workspace: "ungroupedWorkspace",
  agent: "ungroupedAgent",
  team: "ungroupedTeam",
}

/** Section-header icon per axis — the same glyphs the guild rail uses. */
export const CONVERSATION_GROUP_AXIS_ICON: Record<ConversationGroupAxis, LucideIcon> = {
  workspace: FolderIcon,
  agent: BotIcon,
  team: UsersIcon,
}
