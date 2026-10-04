/**
 * How the chat dock names and draws each session-surface panel when the panel
 * itself is not mounted (ADR-0214, D6).
 *
 * The dock's one tab strip shows a conversation's panel tabs beside its
 * artifact tabs, and the artifact surface is what is mounted while an artifact
 * tab is in front — so the strip cannot read labels and icons off the session
 * surface's live definitions (`useSessionSurfacePanels`), which are built in a
 * hook over session state. Building them a second time for the strip would
 * double their subscriptions (plans, workspace changes, comment badges) for
 * two strings and a glyph.
 *
 * So the identities live here, and `chat-dock-panels.test.tsx` holds every
 * session panel's `labelKey`, `icon` and `preferredMode` equal to this table.
 * Plugin panels are not listed: the strip reads those from
 * `contextPanelRegistry`, which already carries them.
 *
 * A plain module with no React tree behind it, so the strip and the New Tab
 * page can import it without pulling in the panels it describes.
 */

import {
  ActivityIcon,
  BrainIcon,
  FileSearchIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  LibraryIcon,
  ListChecksIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchCodeIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { NEW_TAB_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import type { ContextPanelMode } from "@/types/context-workbench"

/**
 * The browser-style start page (D7). Its own panel so the workbench owns its
 * mount and the strip closes it like any other panel tab; at most one per
 * conversation falls out of panel ids being unique per scope. Declared beside
 * the artifact list's id, which the session-focus seam reads too.
 */
export { NEW_TAB_PANEL_ID }

export interface DockPanelMeta {
  labelKey: string
  icon: LucideIcon
  preferredMode?: ContextPanelMode
}

/** Keyed by panel id; the ids equal the constants each panel exports. */
export const DOCK_SESSION_PANEL_META: Readonly<Record<string, DockPanelMeta>> = {
  [NEW_TAB_PANEL_ID]: { labelKey: "contextWorkbench.newTab.title", icon: PlusIcon },
  artifacts: { labelKey: "artifacts.dock.browseArtifacts", icon: LibraryIcon },
  plan: { labelKey: "contextWorkbench.planPanel.title", icon: ListTodoIcon },
  "session-sidechat": { labelKey: "contextWorkbench.sessionSidechat", icon: MessagesSquareIcon },
  "squad-context": { labelKey: "contextWorkbench.squadPanel.title", icon: UsersIcon },
  "team-members": { labelKey: "contextWorkbench.teamMembersPanel.title", icon: UsersIcon },
  browser: { labelKey: "browser.title", icon: GlobeIcon, preferredMode: "wide" },
  "project-overview": {
    labelKey: "projectOverview.panelTitle",
    icon: FolderKanbanIcon,
    preferredMode: "wide",
  },
  workspace: {
    labelKey: "artifacts.dock.workspaceMode",
    icon: SearchCodeIcon,
    preferredMode: "wide",
  },
  "source-control": { labelKey: "contextWorkbench.sourceControlPanel.title", icon: GitBranchIcon },
  comments: { labelKey: "contextWorkbench.comments", icon: MessageSquareIcon },
  "run-context": { labelKey: "contextWorkbench.runContext.title", icon: ListChecksIcon },
  "session-sources": { labelKey: "contextWorkbench.sessionSources.title", icon: FileSearchIcon },
  metadata: { labelKey: "contextWorkbench.metadata.sessionTitle", icon: InfoIcon },
  memory: { labelKey: "contextWorkbench.memoryPanel.title", icon: BrainIcon },
  logs: { labelKey: "contextWorkbench.logsPanel.title", icon: ActivityIcon },
}
