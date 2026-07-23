import type { ComponentType } from "react"
import {
  BlocksIcon,
  BotIcon,
  FileTextIcon,
  HistoryIcon,
  InfoIcon,
  MessageSquareIcon,
  PanelRightIcon,
  PlayIcon,
  SearchCodeIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"

/**
 * The only icons a contributed panel may put on the activity rail.
 *
 * A fixed name→component map rather than letting contributors pass a component:
 * the rail is host chrome, and an arbitrary component there could paint outside
 * the panel it belongs to. Shared by both registration paths so the declarative
 * and imperative APIs offer the same set — the imperative one had no icon field
 * at all, which silently dropped every plugin panel back to the fallback glyph.
 */
export const CONTEXT_PANEL_ICONS: Record<
  PluginContextPanelIcon,
  ComponentType<{ className?: string }>
> = {
  blocks: BlocksIcon,
  bot: BotIcon,
  "file-text": FileTextIcon,
  history: HistoryIcon,
  info: InfoIcon,
  "message-square": MessageSquareIcon,
  "panel-right": PanelRightIcon,
  play: PlayIcon,
  "search-code": SearchCodeIcon,
  settings: SettingsIcon,
  wrench: WrenchIcon,
}

/** Resolve a declared icon name, or `undefined` for panels that omit one. */
export function resolveContextPanelIcon(
  icon: PluginContextPanelIcon | undefined
): ComponentType<{ className?: string }> | undefined {
  return icon ? CONTEXT_PANEL_ICONS[icon] : undefined
}
