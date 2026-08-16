/**
 * Built-in commands (ADR-0129). Each entry is a `command` action the dialog
 * host resolves (`components/global-search/use-global-search-actions.ts`),
 * so this module stays store-free and testable. Entries can be gated on host
 * facts (`recorderAvailable`) and can carry a keyboard hint in `meta`.
 */

import {
  CheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
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
  | "open-folder"
  | "open-recorder"
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
      extra: ctx.isTauri ? undefined : { disabledReason: t("globalSearch.actions.desktopOnly") },
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
