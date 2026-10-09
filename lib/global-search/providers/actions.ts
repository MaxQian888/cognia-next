/**
 * Built-in commands (ADR-0129). Each entry is a `command` action the dialog
 * host resolves (`components/global-search/use-global-search-actions.ts`),
 * so this module stays store-free and testable. Entries can be gated on host
 * facts (`recorderAvailable`) and can carry a keyboard hint in `meta`.
 */

import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  CheckIcon,
  DownloadIcon,
  EyeOffIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  GlobeIcon,
  KeyRoundIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PawPrintIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
  UsersIcon,
  UsersRoundIcon,
  VideoIcon,
} from "lucide-react"

import { matchTitles } from "./helpers"
import type { GlobalSearchContext, GlobalSearchItem, GlobalSearchProvider } from "../types"

export const ACTIONS_PROVIDER_ID = "builtin.actions"

/** Every built-in command id the dialog host must implement. */
export type BuiltinCommandId =
  | "new-chat"
  | "export-markdown"
  | "clear-conversation"
  | "toggle-theme"
  | "toggle-sidebar"
  | "pin-current-page"
  | "unpin-current-page"
  | "hide-current-page"
  | "customize-navigation"
  | "show-nav-rail"
  | "hide-nav-rail"
  | "move-nav-rail-left"
  | "move-nav-rail-right"
  | "open-folder"
  | "new-workspace"
  | "adopt-workspaces"
  | "manage-workspace-roots"
  | "open-recorder"
  | "open-browser"
  | "toggle-desktop-pet"
  | "open-pet-console"
  | "check-updates"
  | "open-settings"
  | "manage-api-key"
  | "manage-characters"
  | "manage-skills"
  | "manage-teams"
  | "manage-mcp"
  | "clear-recent-searches"

interface ActionCandidate {
  id: BuiltinCommandId
  title: string
  subtitle?: string
  keywords: string[]
  icon: GlobalSearchItem["icon"]
  /** Right-aligned hint (a shortcut, a note). */
  meta?: string
  extra?: GlobalSearchItem["extra"]
  /** Rank boost for the handful of commands people reach for constantly. */
  primary?: boolean
}

export function actionCandidates(ctx: GlobalSearchContext): ActionCandidate[] {
  const t = ctx.t
  const dark = ctx.host.theme === "dark"
  const rows: ActionCandidate[] = [
    {
      id: "new-chat",
      title: t("globalSearch.actions.newChat"),
      subtitle: t("globalSearch.actions.newChatHint"),
      keywords: ["new", "chat", "conversation", "create", "start", "新建", "会话"],
      icon: { lucide: PlusIcon },
      primary: true,
    },
    {
      id: "toggle-theme",
      title: dark
        ? t("globalSearch.actions.switchToLight")
        : t("globalSearch.actions.switchToDark"),
      keywords: ["theme", "dark", "light", "appearance", "主题", "深色", "浅色"],
      icon: { lucide: dark ? SunIcon : MoonIcon },
      primary: true,
    },
    {
      id: "toggle-sidebar",
      title: t("globalSearch.actions.toggleSidebar"),
      keywords: ["sidebar", "rail", "collapse", "侧栏"],
      icon: { lucide: PanelLeftIcon },
    },
    ...navigationCandidates(ctx),
    {
      id: "export-markdown",
      title: t("globalSearch.actions.exportMd"),
      keywords: ["export", "markdown", "download", "save", "导出"],
      icon: { lucide: DownloadIcon },
    },
    {
      id: "clear-conversation",
      title: t("globalSearch.actions.clearChat"),
      keywords: ["clear", "delete", "messages", "清空"],
      icon: { lucide: Trash2Icon },
    },
    {
      id: "open-folder",
      title: t("globalSearch.actions.openFolder"),
      keywords: ["folder", "workspace", "open", "directory", "文件夹", "工作区"],
      icon: { lucide: FolderOpenIcon },
      /*
        Gated on whether a folder can be chosen AT ALL, not on `isTauri`. A
        paired phone or browser walks the host's filesystem through the same
        picker the workspace switcher opens; only an unpaired browser has
        nowhere to look. The old `isTauri` gate meant the switcher offered this
        and the palette refused it, on the same device, in the same second.
      */
      extra: ctx.host.canBrowseHostFolders
        ? undefined
        : { disabledReason: t("globalSearch.actions.openFolderNeedsHost") },
    },
    /*
      The other three entries of the switcher's footer. They existed only inside
      a Popover in the desktop rail and a Drawer on `/`, so on any other mobile
      route there was no way to create, adopt or manage a workspace at all.
    */
    {
      id: "new-workspace",
      title: t("globalSearch.actions.newWorkspace"),
      keywords: ["workspace", "project", "new", "create", "工作区", "新建"],
      icon: { lucide: FolderPlusIcon },
    },
    {
      id: "adopt-workspaces",
      title: t("globalSearch.actions.adoptWorkspaces"),
      keywords: ["adopt", "detected", "folders", "workspace", "收编", "工作区"],
      icon: { lucide: FolderSearchIcon },
    },
    {
      id: "manage-workspace-roots",
      title: t("globalSearch.actions.manageWorkspaceRoots"),
      keywords: ["manage", "roots", "folders", "workspace", "工作区", "根目录"],
      icon: { lucide: SlidersHorizontalIcon },
    },
    ...(ctx.host.recorderAvailable
      ? [
          {
            id: "open-recorder" as const,
            title: t("skills.recorder.entry.paletteLabel"),
            meta: t("skills.recorder.entry.paletteHint"),
            keywords: ["record", "skill", "recorder", "录制"],
            icon: { lucide: VideoIcon },
          },
        ]
      : []),
    // The embedded browser had no entry anywhere outside the pane itself: no
    // slash command, no palette row, no workflow node.
    {
      id: "open-browser",
      title: t("globalSearch.actions.openBrowser"),
      subtitle: t("globalSearch.actions.openBrowserHint"),
      keywords: ["browser", "preview", "web", "localhost", "浏览器", "预览"],
      icon: { lucide: GlobeIcon },
      extra: ctx.isTauri ? undefined : { disabledReason: t("globalSearch.actions.desktopOnly") },
    },
    // The desktop pet (ADR-0058). Hidden, not disabled, where it cannot run:
    // only the desktop main window hosts the pet, so a greyed "show desktop
    // pet" row anywhere else would advertise something the client cannot
    // have. Summoning switches a disabled pet on (D9), so the pet's own
    // setting does not gate it.
    ...(ctx.host.petHostAvailable
      ? [
          {
            id: "toggle-desktop-pet" as const,
            title: t("globalSearch.actions.toggleDesktopPet"),
            keywords: [
              "pet",
              "desktop pet",
              "companion",
              "mascot",
              "overlay",
              "show",
              "hide",
              "宠物",
              "桌宠",
              "显示",
              "隐藏",
            ],
            icon: { lucide: PawPrintIcon },
          },
        ]
      : []),
    // The console also opens on a client paired to a host that advertises
    // remote pet care (ADR-0219): it cares for that desktop's pet from here.
    ...(ctx.host.petConsoleReachable
      ? [
          {
            id: "open-pet-console" as const,
            title: t("globalSearch.actions.openPetConsole"),
            subtitle: t("globalSearch.actions.openPetConsoleHint"),
            keywords: ["pet", "console", "panel", "nurture", "feed", "宠物", "面板", "喂养"],
            icon: { lucide: PawPrintIcon },
          },
        ]
      : []),
    {
      id: "open-settings",
      title: t("globalSearch.actions.openSettings"),
      keywords: ["settings", "preferences", "config", "设置"],
      icon: { lucide: SettingsIcon },
      primary: true,
    },
    {
      id: "manage-api-key",
      title: t("globalSearch.actions.manageApiKey"),
      keywords: ["api", "key", "token", "anthropic", "provider", "密钥"],
      icon: { lucide: ctx.host.hasApiKey ? CheckIcon : KeyRoundIcon },
      extra: { current: ctx.host.hasApiKey },
    },
    {
      id: "manage-characters",
      title: t("globalSearch.actions.manageCharacters"),
      keywords: ["characters", "persona", "agents", "角色"],
      icon: { lucide: UsersRoundIcon },
    },
    {
      id: "manage-skills",
      title: t("globalSearch.actions.manageSkills"),
      keywords: ["skills", "技能"],
      icon: { lucide: SparklesIcon },
    },
    {
      id: "manage-teams",
      title: t("globalSearch.actions.manageTeams"),
      keywords: ["teams", "团队"],
      icon: { lucide: UsersIcon },
    },
    {
      id: "manage-mcp",
      title: t("globalSearch.actions.manageMcp"),
      keywords: ["mcp", "servers", "tools", "服务器"],
      icon: { lucide: ServerIcon },
    },
    {
      id: "check-updates",
      title: t("globalSearch.actions.checkUpdates"),
      keywords: ["update", "version", "upgrade", "更新"],
      icon: { lucide: RefreshCwIcon },
      extra: ctx.isTauri ? undefined : { disabledReason: t("globalSearch.actions.desktopOnly") },
    },
    {
      id: "clear-recent-searches",
      title: t("globalSearch.actions.clearRecents"),
      keywords: ["recent", "history", "clear", "最近"],
      icon: { lucide: Trash2Icon },
    },
  ]
  return rows
}

/** Words every navigation-customization row answers to, in both languages. */
const NAV_KEYWORDS = ["navigation", "nav", "rail", "sidebar", "导航", "导航栏", "侧栏"]

/**
 * Navigation-rail customization: pin, unpin and hide the page in front, open
 * the customizer, and fold or move the rail.
 *
 * The three page commands name the page but carry no id. The handler resolves
 * the page from the route again when it runs, so a recent pin replayed on
 * another page acts on the page in front (its toast names which), never on one
 * the user has left. They are offered on mobile too: the drawer renders the
 * rail's pinned block and More menu from the same layout, so a pin shows there.
 *
 * Folding and moving the rail only exist where the rail is window chrome
 * (`railChrome`), and the customizer only where its settings section is
 * reachable (the desktop shell, `profiles: ["desktop"]`).
 */
function navigationCandidates(ctx: GlobalSearchContext): ActionCandidate[] {
  const t = ctx.t
  const nav = ctx.host.shellNav
  const rows: ActionCandidate[] = []
  const page = nav.currentPage
  if (page) {
    const label = t(`desktop.guildRail.${page.i18nKey}`)
    if (!nav.currentPinned) {
      rows.push({
        id: "pin-current-page",
        title: t("globalSearch.actions.pinPage", { page: label }),
        // Pinning un-hides, which is worth saying when the page is hidden now.
        subtitle: nav.currentHidden ? t("globalSearch.actions.pinHiddenPageHint") : undefined,
        keywords: [...NAV_KEYWORDS, "pin", "page", "固定", "页面"],
        icon: { lucide: PinIcon },
      })
    } else {
      rows.push({
        id: "unpin-current-page",
        title: t("globalSearch.actions.unpinPage", { page: label }),
        subtitle: t("globalSearch.actions.unpinPageHint"),
        keywords: [...NAV_KEYWORDS, "unpin", "more", "page", "取消固定", "更多", "页面"],
        icon: { lucide: PinOffIcon },
      })
    }
    if (!nav.currentHidden) {
      rows.push({
        id: "hide-current-page",
        title: t("globalSearch.actions.hidePage", { page: label }),
        subtitle: t("globalSearch.actions.hidePageHint"),
        keywords: [...NAV_KEYWORDS, "hide", "remove", "page", "隐藏", "页面"],
        icon: { lucide: EyeOffIcon },
      })
    }
  }
  if (ctx.host.reachableSettingsSections.has("sidebar")) {
    rows.push({
      id: "customize-navigation",
      title: t("globalSearch.actions.customizeNavigation"),
      keywords: [...NAV_KEYWORDS, "customize", "reorder", "pin", "hide", "自定义", "排序", "固定"],
      icon: { lucide: Settings2Icon },
    })
  }
  if (nav.railChrome) {
    const right = nav.side === "right"
    /*
      One id per outcome rather than a toggle, so the row's title and a
      replayed recent agree: a recent "Show navigation rail" shows it, and is a
      no-op when it is already showing, instead of flipping it away again.
    */
    rows.push(
      nav.railCollapsed
        ? {
            id: "show-nav-rail",
            title: t("globalSearch.actions.showNavRail"),
            keywords: [...NAV_KEYWORDS, "show", "expand", "显示", "展开"],
            icon: { lucide: right ? PanelRightOpenIcon : PanelLeftOpenIcon },
          }
        : {
            id: "hide-nav-rail",
            title: t("globalSearch.actions.hideNavRail"),
            keywords: [...NAV_KEYWORDS, "hide", "collapse", "隐藏", "折叠"],
            icon: { lucide: right ? PanelRightCloseIcon : PanelLeftCloseIcon },
          },
      // Named by the edge it goes TO, like the theme row names the theme.
      right
        ? {
            id: "move-nav-rail-left",
            title: t("globalSearch.actions.moveNavRailLeft"),
            keywords: [...NAV_KEYWORDS, "move", "side", "left", "移动", "位置", "左侧"],
            icon: { lucide: ArrowLeftToLineIcon },
          }
        : {
            id: "move-nav-rail-right",
            title: t("globalSearch.actions.moveNavRailRight"),
            keywords: [...NAV_KEYWORDS, "move", "side", "right", "移动", "位置", "右侧"],
            icon: { lucide: ArrowRightToLineIcon },
          }
    )
  }
  return rows
}

function toItem(
  c: ActionCandidate,
  score: number,
  positions: readonly number[] = []
): GlobalSearchItem {
  return {
    id: `action:${c.id}`,
    kind: "action",
    title: c.title,
    titlePositions: positions,
    subtitle: c.subtitle,
    meta: c.meta,
    icon: c.icon,
    keywords: c.keywords,
    score: Math.min(1, score + (c.primary ? 0.03 : 0)),
    extra: c.extra,
    action: { type: "command", id: c.id },
  }
}

export const actionsProvider: GlobalSearchProvider = {
  id: ACTIONS_PROVIDER_ID,
  kind: "action",
  search({ query, ctx, limit }) {
    const { hits, total, truncated } = matchTitles(actionCandidates(ctx), query.needle, {
      getTitle: (c) => c.title,
      getSecondary: (c) => c.subtitle,
      getKeywords: (c) => c.keywords,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => toItem(row, match.score, match.positions)),
      total,
      truncated,
    }
  },
  suggest({ ctx, limit }) {
    return actionCandidates(ctx)
      .filter((c) => c.primary)
      .slice(0, limit)
      .map((c, index) => toItem(c, 1 - index / (limit + 1)))
  },
}
