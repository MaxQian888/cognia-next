/**
 * The plugin contract's share of `lib/plugin/api/message-part-renderers.ts`, which re-exports these.
 */
import type React from "react"
import type { UIMessage } from "ai"

export interface MessagePartRendererProps {
  /** The part that triggered the renderer — exactly the value from `UIMessage.parts[i]`. */
  part: UIMessage["parts"][number]
  /** Id of the message this part belongs to. Plugins can use it for keying. */
  messageId?: string
  /** True while this is the most recent assistant message and we're still streaming. */
  isStreaming?: boolean
}

export interface MessagePartRendererEntry {
  pluginId: string
  type: string
  component: React.ComponentType<MessagePartRendererProps>
}
