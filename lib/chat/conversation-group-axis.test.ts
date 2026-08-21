import { BotIcon, FolderIcon, UsersIcon } from "lucide-react"

import type { ConversationGroupAxis } from "@/lib/chat/conversation-list-model"
import {
  CONVERSATION_GROUP_AXIS_ICON,
  CONVERSATION_UNGROUPED_LABEL_KEY,
} from "@/lib/chat/conversation-group-axis"

const AXES: readonly ConversationGroupAxis[] = ["workspace", "agent", "team"]

describe("conversation group axis presentation", () => {
  it("covers every axis, so a new one cannot ship without a label and an icon", () => {
    // `Record<ConversationGroupAxis, …>` makes this a compile error too; the
    // runtime check is what catches a key deleted by a bad merge.
    expect(Object.keys(CONVERSATION_UNGROUPED_LABEL_KEY).sort()).toEqual([...AXES].sort())
    expect(Object.keys(CONVERSATION_GROUP_AXIS_ICON).sort()).toEqual([...AXES].sort())
  })

  it("gives each axis its own label key", () => {
    const keys = Object.values(CONVERSATION_UNGROUPED_LABEL_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("names the team axis's ungrouped bucket after direct chats, not leftovers", () => {
    expect(CONVERSATION_UNGROUPED_LABEL_KEY.team).toBe("ungroupedTeam")
    expect(CONVERSATION_GROUP_AXIS_ICON.team).toBe(UsersIcon)
  })

  it("keeps the guild rail's glyphs for the other two axes", () => {
    expect(CONVERSATION_GROUP_AXIS_ICON.workspace).toBe(FolderIcon)
    expect(CONVERSATION_GROUP_AXIS_ICON.agent).toBe(BotIcon)
  })
})
