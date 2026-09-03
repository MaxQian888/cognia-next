/**
 * Default icon per search kind (ADR-0129). Providers usually attach a more
 * specific icon. This is the fallback for rows without one, which is stored
 * recents and plugin providers that skipped it.
 *
 * The map is typed as a full `Record<GlobalSearchKind, …>`, so a new kind is
 * supposed to be a compile error here. It was not: `squad` and `site` were both
 * absent for as long as those kinds have existed, and every row that reached
 * this fallback rendered the generic command glyph. Full-repo `tsc` OOMs in this
 * repo before it checks anything, which is why the type never spoke up and why
 * `kind-icons.test.ts` walking `KIND_SCOPES` is the check that actually holds.
 */

import {
  BrainIcon,
  CalendarClockIcon,
  CircleDotIcon,
  CommandIcon,
  CompassIcon,
  ContactIcon,
  FolderIcon,
  FolderGitIcon,
  GitBranchIcon,
  GlobeIcon,
  InboxIcon,
  LayoutTemplateIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  PackageIcon,
  PanelRightIcon,
  PlugIcon,
  PuzzleIcon,
  ServerCogIcon,
  SmartphoneIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
  UsersRoundIcon,
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
  // Distinct from `team` on purpose. A Squad and a guild of Characters are two
  // different things that both surface in the same result list, and the row
  // text alone does not separate them. Matches the Squads entry on the phone's
  // Me list (`components/mobile/me/me-entries.ts`).
  squad: UsersRoundIcon,
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
  device: SmartphoneIcon,
  issue: CircleDotIcon,
  // Same glyph the `/sites` rail and the sites provider already use.
  site: GlobeIcon,
  // The same two glyphs the branch picker and the worktree list use, so a
  // palette row and the panel it opens read as the same object.
  "git-branch": GitBranchIcon,
  "git-worktree": FolderGitIcon,
}

export function kindIcon(kind: GlobalSearchKind): LucideIcon {
  return KIND_ICONS[kind] ?? CommandIcon
}
