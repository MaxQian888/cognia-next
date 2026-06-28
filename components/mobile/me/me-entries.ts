/**
 * Data-driven registry for the mobile `/me` screen. Turning the previously
 * hardcoded `<MeRow>`s into typed data gives the page a single source of
 * truth for rendering, full-text search, and pin/favorite — while keeping
 * the historical `me-row-<id>` / `me-section-<id>` test ids stable.
 *
 * Note on search: the desktop sidebar's `isSearchMatch`
 * (`components/settings/settings-nav-config.ts`) is hardwired to the
 * `settings.tabs.*` / `settings.descriptions.*` namespaces, so it can't be
 * reused for the `mobile.me.*` labels here. `matchMeEntry` is the ~5-line
 * equivalent scoped to this namespace.
 */

import type { LucideIcon } from "lucide-react"
import {
  BellIcon,
  BookmarkIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  ChartBarIcon,
  DatabaseIcon,
  HardDriveIcon,
  InfoIcon,
  KeyRoundIcon,
  LinkIcon,
  MessagesSquareIcon,
  MessageSquareIcon,
  MonitorIcon,
  PaletteIcon,
  SearchIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  TargetIcon,
  TerminalSquareIcon,
  TypeIcon,
  UserRoundIcon,
  Volume2Icon,
} from "lucide-react"

export type MeSectionId =
  | "account"
  | "appearance"
  | "connection"
  | "automation"
  | "data"
  | "about"

export interface MeEntry {
  /** Stable id — drives the `me-row-<id>` test id and the pin set. */
  id: string
  icon: LucideIcon
  /** i18n key under `mobile.me.<labelKey>`. */
  labelKey: string
  href: string
  section: MeSectionId
  /** Extra (bilingual) search keywords beyond the localized label. */
  keywords?: string[]
}

/** Display order of the grouped sections. */
export const ME_SECTION_ORDER: MeSectionId[] = [
  "account",
  "appearance",
  "connection",
  "automation",
  "data",
  "about",
]

/** Section id → `mobile.me.<key>` heading key. */
export const ME_SECTION_TITLE_KEY: Record<MeSectionId, string> = {
  account: "sectionAccount",
  appearance: "sectionAppearance",
  connection: "sectionConnection",
  automation: "sectionAutomation",
  data: "sectionData",
  about: "sectionAbout",
}

/**
 * The standard navigational rows. Conditional/dynamic rows (Pair, Devices'
 * short id, Sync's last-synced stamp, the Version row) stay in the page and
 * are NOT listed here — they aren't plain links and aren't pinnable.
 */
export const ME_ENTRIES: MeEntry[] = [
  // === Account ===
  {
    id: "profile",
    icon: UserRoundIcon,
    labelKey: "profileRow",
    href: "/me/profile",
    section: "account",
    keywords: ["profile", "name", "avatar", "bio", "资料", "昵称", "头像"],
  },
  {
    id: "subscription",
    icon: KeyRoundIcon,
    labelKey: "subscriptionRow",
    href: "/me/subscription",
    section: "account",
    keywords: ["account", "plan", "anthropic", "订阅", "账号", "套餐"],
  },
  {
    id: "sync",
    icon: RefreshCwIcon,
    labelKey: "syncRow",
    href: "/me/sync",
    section: "account",
    keywords: ["sync", "同步", "cursor"],
  },
  {
    id: "devices",
    icon: SmartphoneIcon,
    labelKey: "devicesRow",
    href: "/me/devices",
    section: "account",
    keywords: ["device", "paired", "设备", "配对"],
  },
  {
    id: "remote-sessions",
    icon: RadioTowerIcon,
    labelKey: "remoteSessionsRow",
    href: "/remote-sessions",
    section: "account",
    keywords: ["remote", "session", "control", "approval", "远程", "会话", "审批"],
  },

  // === Appearance & experience ===
  {
    id: "appearance",
    icon: PaletteIcon,
    labelKey: "appearanceLink",
    href: "/me/appearance",
    section: "appearance",
    keywords: ["theme", "wallpaper", "dark", "light", "主题", "壁纸", "外观"],
  },
  {
    id: "notifications",
    icon: BellIcon,
    labelKey: "notificationsRow",
    href: "/me/notifications",
    section: "appearance",
    keywords: ["notification", "push", "reminder", "通知", "提醒"],
  },
  {
    id: "preferences",
    icon: TypeIcon,
    labelKey: "preferencesRow",
    href: "/me/preferences",
    section: "appearance",
    keywords: ["font", "model", "字号", "默认模型"],
  },
  {
    id: "presets",
    icon: BookmarkIcon,
    labelKey: "presetsRow",
    href: "/me/presets",
    section: "appearance",
    keywords: ["preset", "system prompt", "预设", "系统提示词"],
  },
  {
    id: "speech",
    icon: Volume2Icon,
    labelKey: "speechRow",
    href: "/me/speech",
    section: "appearance",
    keywords: ["speech", "voice", "tts", "stt", "audio", "语音", "朗读", "声音"],
  },
  {
    id: "conversation",
    icon: MessagesSquareIcon,
    labelKey: "conversationRow",
    href: "/me/conversation",
    section: "appearance",
    keywords: ["conversation", "title", "timeline", "minimap", "会话", "标题", "时间线"],
  },

  // === Connection & extensions ===
  {
    id: "providers",
    icon: KeyRoundIcon,
    labelKey: "providersRow",
    href: "/me/providers",
    section: "connection",
    keywords: ["api key", "provider", "byok", "anthropic", "openai", "密钥", "提供商", "模型"],
  },
  {
    id: "connectors",
    icon: LinkIcon,
    labelKey: "connectorsRow",
    href: "/me/connectors",
    section: "connection",
    keywords: ["telegram", "discord", "slack", "lark", "连接器", "平台"],
  },
  {
    id: "ocr",
    icon: SlidersHorizontalIcon,
    labelKey: "ocrRow",
    href: "/me/ocr",
    section: "connection",
    keywords: ["ocr", "image", "pdf", "识别", "图片"],
  },
  {
    id: "web-search",
    icon: SearchIcon,
    labelKey: "webSearchRow",
    href: "/me/web-search",
    section: "connection",
    keywords: ["web search", "tavily", "perplexity", "results", "搜索", "联网"],
  },
  {
    id: "search",
    icon: SparklesIcon,
    labelKey: "searchRow",
    href: "/search",
    section: "connection",
    keywords: ["search", "ask the web", "research", "cited answer", "提问", "联网搜索", "引用"],
  },
  {
    id: "computer-use",
    icon: MonitorIcon,
    labelKey: "computerUseRow",
    href: "/me/computer-use",
    section: "connection",
    keywords: ["computer use", "automation", "桌面"],
  },
  {
    id: "terminal",
    icon: TerminalSquareIcon,
    labelKey: "terminalRow",
    href: "/me/terminal",
    section: "connection",
    keywords: ["terminal", "shell", "command", "终端", "命令行"],
  },

  // === Automation ===
  {
    id: "scheduler",
    icon: CalendarClockIcon,
    labelKey: "schedulerRow",
    href: "/me/scheduler",
    section: "automation",
    keywords: ["schedule", "cron", "task", "计划", "定时", "任务"],
  },
  {
    id: "goals",
    icon: TargetIcon,
    labelKey: "goalsRow",
    href: "/goals",
    section: "automation",
    keywords: ["goal", "objective", "progress", "目标", "进度"],
  },

  // === Data ===
  {
    id: "backup",
    icon: SaveIcon,
    labelKey: "backupRow",
    href: "/me/backup",
    section: "data",
    keywords: ["backup", "restore", "export", "备份", "恢复"],
  },
  {
    id: "maintenance",
    icon: DatabaseIcon,
    labelKey: "dexieMaintenance",
    href: "/me/maintenance",
    section: "data",
    keywords: ["dexie", "indexeddb", "database", "维护"],
  },
  {
    id: "storage",
    icon: HardDriveIcon,
    labelKey: "storageRow",
    href: "/me/storage",
    section: "data",
    keywords: ["storage", "usage", "disk", "存储", "用量"],
  },
  {
    id: "memory",
    icon: BrainIcon,
    labelKey: "memoryRow",
    href: "/memory",
    section: "data",
    keywords: ["memory", "recall", "long-term", "记忆", "长期记忆"],
  },

  // === About ===
  {
    id: "about",
    icon: InfoIcon,
    labelKey: "aboutRow",
    href: "/me/about",
    section: "about",
    keywords: ["about", "version", "关于", "版本"],
  },
  {
    id: "help",
    icon: BookOpenIcon,
    labelKey: "helpRow",
    href: "/me/help",
    section: "about",
    keywords: ["help", "docs", "documentation", "帮助", "文档"],
  },
  {
    id: "feedback",
    icon: MessageSquareIcon,
    labelKey: "feedbackRow",
    href: "/me/feedback",
    section: "about",
    keywords: ["feedback", "issue", "diagnostics", "反馈", "诊断"],
  },
  {
    id: "device-info",
    icon: ChartBarIcon,
    labelKey: "deviceInfoRow",
    href: "/me/device-info",
    section: "about",
    keywords: ["device info", "build", "permission", "设备信息", "权限"],
  },
]

/**
 * Case-insensitive match of an entry against a search query. Empty query
 * matches everything. Matches the localized label first, then any attached
 * bilingual keywords.
 */
export function matchMeEntry(
  entry: MeEntry,
  query: string,
  t: (key: string) => string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (t(entry.labelKey).toLowerCase().includes(q)) return true
  return (entry.keywords ?? []).some((k) => k.toLowerCase().includes(q))
}
