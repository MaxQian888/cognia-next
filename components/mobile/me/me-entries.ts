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
import type { MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
import {
  ActivityIcon,
  AppWindowIcon,
  BrainCircuitIcon,
  DramaIcon,
  FileTextIcon,
  GraduationCapIcon,
  GitBranchIcon,
  PenToolIcon,
  ShapesIcon,
  UserCogIcon,
  BellIcon,
  BotIcon,
  BookmarkIcon,
  BookOpenIcon,
  BrainIcon,
  CloudIcon,
  CalendarClockIcon,
  ChartBarIcon,
  ClipboardCheckIcon,
  DatabaseIcon,
  HardDriveIcon,
  HistoryIcon,
  InfoIcon,
  KeyRoundIcon,
  LinkIcon,
  MessagesSquareIcon,
  MessageSquareIcon,
  MonitorIcon,
  NetworkIcon,
  PaletteIcon,
  PlugIcon,
  PuzzleIcon,
  SearchIcon,
  ServerIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SaveIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  TargetIcon,
  WorkflowIcon,
  TerminalSquareIcon,
  TypeIcon,
  UserRoundIcon,
  UsersRoundIcon,
  Volume2Icon,
  WebhookIcon,
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
  /** Larger companion illustration for selected high-value feature rows. */
  spotIcon?: MobileSpotIconName
  /** i18n key under `mobile.me.<labelKey>`. */
  labelKey: string
  href: string
  section: MeSectionId
  /** Extra (bilingual) search keywords beyond the localized label. */
  keywords?: string[]
  /**
   * ADR-0056 D2 — page body renders a `PairedOnly` placeholder without a
   * paired desktop. The row stays visible but is annotated on `/me` so the
   * user knows before tapping.
   */
  pairedOnly?: boolean
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
    spotIcon: "profile",
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
    id: "cloud-account",
    icon: CloudIcon,
    labelKey: "cloudAccountRow",
    href: "/me/cloud-account",
    section: "account",
    keywords: ["logto", "cloud", "sso", "oidc", "sign in", "云", "登录", "账号"],
  },
  {
    id: "sync",
    icon: RefreshCwIcon,
    spotIcon: "device-sync",
    labelKey: "syncRow",
    href: "/me/sync",
    section: "account",
    keywords: ["sync", "同步", "cursor"],
  },
  {
    id: "devices",
    icon: SmartphoneIcon,
    labelKey: "devicesRow",
    // Was `/me/devices`, a mobile-only wrapper around the paired-devices card.
    // `FeaturePageShell` already collapses to a single column with sheet
    // triggers below `md`, so the console serves both shells from one tree.
    href: "/devices",
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
    spotIcon: "chat",
    labelKey: "conversationRow",
    href: "/me/conversation",
    section: "appearance",
    keywords: ["conversation", "title", "timeline", "minimap", "会话", "标题", "时间线"],
  },
  {
    id: "artifacts",
    icon: ShapesIcon,
    labelKey: "artifactsRow",
    href: "/me/artifacts",
    section: "appearance",
    keywords: ["artifact", "code", "html", "react", "svg", "mermaid", "制品"],
  },
  {
    id: "canvas",
    icon: PenToolIcon,
    spotIcon: "canvas",
    labelKey: "canvasRow",
    href: "/me/canvas",
    section: "appearance",
    keywords: ["canvas", "monaco", "editor", "画布", "编辑器"],
  },

  // === Connection & extensions ===
  {
    id: "agent",
    pairedOnly: true,
    icon: BotIcon,
    spotIcon: "digital-twin",
    labelKey: "agentRow",
    href: "/me/agent",
    section: "connection",
    keywords: [
      "agent",
      "permission",
      "system prompt",
      "thinking",
      "代理",
      "权限",
      "系统提示词",
      "思考",
    ],
  },
  {
    id: "providers",
    icon: KeyRoundIcon,
    labelKey: "providersRow",
    href: "/me/providers",
    section: "connection",
    keywords: ["api key", "provider", "byok", "anthropic", "openai", "密钥", "提供商", "模型"],
  },
  {
    id: "model-catalog",
    icon: DatabaseIcon,
    labelKey: "modelCatalogRow",
    href: "/me/model-catalog",
    section: "connection",
    keywords: ["model", "catalog", "offering", "alias", "模型", "目录", "提供方"],
  },
  {
    id: "connectors",
    icon: LinkIcon,
    spotIcon: "connectors",
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
    spotIcon: "browser",
    labelKey: "webSearchRow",
    href: "/me/web-search",
    section: "connection",
    keywords: ["web search", "tavily", "perplexity", "results", "搜索", "联网"],
  },
  {
    id: "search",
    icon: SparklesIcon,
    spotIcon: "discover",
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
    id: "source-control",
    pairedOnly: true,
    icon: GitBranchIcon,
    labelKey: "sourceControlRow",
    href: "/source-control",
    section: "connection",
    keywords: ["git", "source control", "repository", "版本控制", "代码仓库"],
  },
  {
    id: "terminal",
    icon: TerminalSquareIcon,
    spotIcon: "terminal",
    labelKey: "terminalRow",
    href: "/me/terminal",
    section: "connection",
    keywords: ["terminal", "shell", "command", "终端", "命令行"],
  },
  {
    id: "command-history",
    icon: HistoryIcon,
    labelKey: "commandHistoryRow",
    href: "/me/command-history",
    section: "connection",
    keywords: ["command history", "terminal", "shell", "recent", "命令历史", "终端", "历史"],
  },
  {
    id: "instructions",
    pairedOnly: true,
    icon: ScrollTextIcon,
    labelKey: "instructionsRow",
    href: "/me/instructions",
    section: "connection",
    keywords: [
      "instructions",
      "claude.md",
      "agents.md",
      "project",
      "指令",
      "项目",
    ],
  },
  {
    id: "plugins",
    icon: PuzzleIcon,
    labelKey: "pluginsRow",
    href: "/me/plugins",
    section: "connection",
    keywords: ["plugin", "extension", "addon", "插件", "扩展"],
  },
  {
    id: "subagents",
    pairedOnly: true,
    icon: NetworkIcon,
    labelKey: "subagentsRow",
    href: "/me/subagents",
    section: "connection",
    keywords: ["subagent", "agent", "template", "dispatch", "子代理", "代理", "模板"],
  },
  {
    id: "mcp",
    pairedOnly: true,
    icon: ServerIcon,
    labelKey: "mcpRow",
    href: "/me/mcp",
    section: "connection",
    keywords: ["mcp", "model context protocol", "server", "tool", "服务器", "工具"],
  },
  {
    id: "external-agents",
    pairedOnly: true,
    icon: PlugIcon,
    labelKey: "externalAgentsRow",
    href: "/me/external-agents",
    section: "connection",
    keywords: [
      "external agent",
      "acp",
      "codex",
      "opencode",
      "permission",
      "外部代理",
      "外部 agent",
      "权限",
    ],
  },
  {
    id: "slash-commands",
    pairedOnly: true,
    icon: TerminalSquareIcon,
    labelKey: "slashCommandsRow",
    href: "/me/slash-commands",
    section: "connection",
    keywords: ["slash", "command", "/clear", "composer", "斜杠", "命令"],
  },
  {
    id: "network",
    pairedOnly: true,
    icon: NetworkIcon,
    labelKey: "networkRow",
    href: "/me/network",
    section: "connection",
    keywords: ["network", "proxy", "connectivity", "online", "网络", "代理", "连接"],
  },
  {
    id: "hooks",
    pairedOnly: true,
    icon: WebhookIcon,
    labelKey: "hooksRow",
    href: "/me/hooks",
    section: "connection",
    keywords: ["hook", "lifecycle", "trigger", "settings.json", "钩子", "生命周期"],
  },
  {
    id: "agent-teams-settings",
    pairedOnly: true,
    icon: UsersRoundIcon,
    spotIcon: "agent-teams",
    labelKey: "agentTeamsSettingsRow",
    href: "/me/agent-teams-settings",
    section: "connection",
    keywords: ["agent team", "template", "collaboration", "团队", "智能体团队", "模板"],
  },
  {
    id: "characters",
    icon: DramaIcon,
    labelKey: "charactersRow",
    href: "/me/characters",
    section: "connection",
    keywords: ["character", "persona", "role", "角色", "人格"],
  },
  {
    id: "skills",
    icon: GraduationCapIcon,
    spotIcon: "skills",
    labelKey: "skillsRow",
    href: "/me/skills",
    section: "connection",
    keywords: ["skill", "instruction", "技能", "指令块"],
  },
  {
    id: "teams",
    icon: UsersRoundIcon,
    labelKey: "teamsRow",
    href: "/me/teams",
    section: "connection",
    keywords: ["team", "multi-character", "coordination", "团队", "多角色", "协作"],
  },
  {
    id: "agent-modes",
    icon: UserCogIcon,
    labelKey: "agentModesRow",
    href: "/me/agent-modes",
    section: "connection",
    keywords: ["agent mode", "custom mode", "system prompt", "代理模式", "自定义模式"],
  },
  {
    id: "a2ui",
    icon: AppWindowIcon,
    labelKey: "a2uiRow",
    href: "/me/a2ui",
    section: "connection",
    keywords: ["a2ui", "mini app", "agent ui", "迷你应用", "界面"],
  },
  {
    id: "eval",
    icon: ClipboardCheckIcon,
    labelKey: "evalRow",
    href: "/me/eval",
    section: "connection",
    keywords: ["eval", "evaluation", "judge", "scorer", "dataset", "评估", "评分", "数据集"],
  },

  // === Automation ===
  {
    id: "scheduler",
    icon: CalendarClockIcon,
    spotIcon: "scheduler",
    labelKey: "schedulerRow",
    href: "/me/scheduler",
    section: "automation",
    keywords: ["schedule", "cron", "task", "计划", "定时", "任务"],
  },
  {
    id: "goals",
    icon: TargetIcon,
    spotIcon: "goals",
    labelKey: "goalsRow",
    href: "/goals",
    section: "automation",
    keywords: ["goal", "objective", "progress", "目标", "进度"],
  },
  {
    id: "workflows-settings",
    icon: WorkflowIcon,
    spotIcon: "workflows",
    labelKey: "workflowsSettingsRow",
    href: "/me/workflows-settings",
    section: "automation",
    keywords: ["workflow", "editor", "performance", "tier", "工作流", "性能", "编辑器"],
  },

  // === Data ===
  {
    id: "backup",
    icon: SaveIcon,
    spotIcon: "secure-backup",
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
    spotIcon: "memory",
    labelKey: "memoryRow",
    href: "/memory",
    section: "data",
    keywords: ["memory", "recall", "long-term", "记忆", "长期记忆"],
  },
  {
    id: "memory-settings",
    icon: BrainCircuitIcon,
    labelKey: "memorySettingsRow",
    href: "/me/memory-settings",
    section: "data",
    keywords: ["memory settings", "extraction", "recall", "privacy", "记忆设置", "召回", "隐私"],
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
  {
    id: "logs",
    icon: FileTextIcon,
    labelKey: "logsRow",
    href: "/me/logs",
    section: "about",
    keywords: ["log", "level", "transport", "retention", "日志", "级别", "留存"],
  },
  {
    id: "diagnostics",
    icon: ActivityIcon,
    labelKey: "diagnosticsRow",
    href: "/me/diagnostics",
    section: "about",
    keywords: ["diagnostics", "crash", "error", "诊断", "崩溃", "错误"],
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
