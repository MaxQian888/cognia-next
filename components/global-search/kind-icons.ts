/**
 * Default icon per search kind (ADR-0129). Providers usually attach a more
 * specific icon; this is the fallback for rows without one (stored recents,
 * plugin providers that skipped it).
 */

import {
  BrainIcon,
  CalendarClockIcon,
  CommandIcon,
  CompassIcon,
  ContactIcon,
  FolderIcon,
  InboxIcon,
  LayoutTemplateIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  PackageIcon,
  PanelRightIcon,
  PlugIcon,
  PuzzleIcon,
  ServerCogIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"

import type { GlobalSearchKind } from "@/lib/global-search/types"

export const KIND_ICONS: Readonly<Record<GlobalSearchKind, LucideIcon>> = {
  action: CommandIcon,
  navigation: CompassIcon,
  settings: SettingsIcon,
  session: MessageSquareIcon,
  message: MessageSquareTextIcon,
  character: UserRoundIcon,
  team: UsersIcon,
  workspace: FolderIcon,
  workflow: WorkflowIcon,
  skill: SparklesIcon,
  memory: BrainIcon,
  template: LayoutTemplateIcon,
  "scheduled-task": CalendarClockIcon,
  plugin: PlugIcon,
  "plugin-action": PuzzleIcon,
  "mcp-server": ServerCogIcon,
  "inbox-conversation": InboxIcon,
  "inbox-contact": ContactIcon,
  "workbench-panel": PanelRightIcon,
  "pi-package": PackageIcon,
}

export function kindIcon(kind: GlobalSearchKind): LucideIcon {
  return KIND_ICONS[kind] ?? CommandIcon
}
