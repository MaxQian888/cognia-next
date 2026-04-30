// Settings navigation map — mirrors Cognia's grouped sidebar at
// `D:\Project\Cognia\app\(main)\settings\page.tsx`. Each group maps to a
// section group label (i18n key under `settings.group<Name>`); each item
// maps to a section id used as the URL `?section=` param + the React key.

import type { ComponentType } from "react"
import {
  CpuIcon,
  PaletteIcon,
  KeyRoundIcon,
  UsersIcon,
  SparklesIcon,
  Layers3Icon,
  PuzzleIcon,
  BookmarkIcon,
  DatabaseIcon,
  MonitorIcon,
  InfoIcon,
  ServerCogIcon,
  GlobeIcon,
  Volume2Icon,
  ScrollTextIcon,
  BugIcon,
  PlugZapIcon,
  BotIcon,
  ClockIcon,
  PencilRulerIcon,
} from "lucide-react"

export type SettingsGroup = "ai" | "extensions" | "interface" | "data" | "observability" | "system"

export type SettingsSectionId =
  | "general"
  | "api-key"
  | "agents"
  | "agent-modes"
  | "search"
  | "appearance"
  | "speech"
  | "characters"
  | "skills"
  | "teams"
  | "presets"
  | "artifacts"
  | "canvas"
  | "mcp"
  | "data"
  | "scheduled-tasks"
  | "logs"
  | "diagnostics"
  | "desktop"
  | "about"

export interface NavItem {
  id: SettingsSectionId
  /** i18n key under `settings.tabs.<key>`. */
  labelKey: string
  /** i18n key under `settings.descriptions.<key>` — sidebar tooltip. */
  descriptionKey: string
  group: SettingsGroup
  icon: ComponentType<{ className?: string }>
  /** True if the section requires desktop / Tauri. */
  desktopOnly?: boolean
}

export const SETTINGS_NAV: NavItem[] = [
  // === AI ===
  {
    id: "general",
    labelKey: "general",
    descriptionKey: "general",
    group: "ai",
    icon: CpuIcon,
  },
  {
    id: "api-key",
    labelKey: "apiKey",
    descriptionKey: "apiKey",
    group: "ai",
    icon: KeyRoundIcon,
  },
  {
    id: "agents",
    labelKey: "agents",
    descriptionKey: "agents",
    group: "ai",
    icon: PlugZapIcon,
  },
  {
    id: "agent-modes",
    labelKey: "agentModes",
    descriptionKey: "agentModes",
    group: "ai",
    icon: BotIcon,
  },
  {
    id: "search",
    labelKey: "search",
    descriptionKey: "search",
    group: "ai",
    icon: GlobeIcon,
  },

  // === Extensions ===
  {
    id: "characters",
    labelKey: "characters",
    descriptionKey: "characters",
    group: "extensions",
    icon: UsersIcon,
  },
  {
    id: "skills",
    labelKey: "skills",
    descriptionKey: "skills",
    group: "extensions",
    icon: SparklesIcon,
  },
  {
    id: "teams",
    labelKey: "teams",
    descriptionKey: "teams",
    group: "extensions",
    icon: Layers3Icon,
  },
  {
    id: "mcp",
    labelKey: "mcp",
    descriptionKey: "mcp",
    group: "extensions",
    icon: PuzzleIcon,
  },

  // === Interface ===
  {
    id: "appearance",
    labelKey: "appearance",
    descriptionKey: "appearance",
    group: "interface",
    icon: PaletteIcon,
  },
  {
    id: "speech",
    labelKey: "speech",
    descriptionKey: "speech",
    group: "interface",
    icon: Volume2Icon,
  },
  {
    id: "presets",
    labelKey: "presets",
    descriptionKey: "presets",
    group: "interface",
    icon: BookmarkIcon,
  },
  {
    id: "artifacts",
    labelKey: "artifacts",
    descriptionKey: "artifacts",
    group: "interface",
    icon: Layers3Icon,
  },
  {
    id: "canvas",
    labelKey: "canvas",
    descriptionKey: "canvas",
    group: "interface",
    icon: PencilRulerIcon,
  },

  // === Data ===
  {
    id: "data",
    labelKey: "data",
    descriptionKey: "data",
    group: "data",
    icon: DatabaseIcon,
  },
  {
    id: "scheduled-tasks",
    labelKey: "scheduledTasks",
    descriptionKey: "scheduledTasks",
    group: "data",
    icon: ClockIcon,
  },

  // === Observability ===
  {
    id: "logs",
    labelKey: "logs",
    descriptionKey: "logs",
    group: "observability",
    icon: ScrollTextIcon,
  },
  {
    id: "diagnostics",
    labelKey: "diagnostics",
    descriptionKey: "diagnostics",
    group: "observability",
    icon: BugIcon,
  },

  // === System ===
  {
    id: "desktop",
    labelKey: "desktop",
    descriptionKey: "desktop",
    group: "system",
    icon: MonitorIcon,
    desktopOnly: true,
  },
  {
    id: "about",
    labelKey: "about",
    descriptionKey: "about",
    group: "system",
    icon: InfoIcon,
  },
]

export const SETTINGS_GROUP_ORDER: SettingsGroup[] = [
  "ai",
  "extensions",
  "interface",
  "data",
  "observability",
  "system",
]

/**
 * Lightweight keyword index for the sidebar search. Each entry can attach
 * extra keywords beyond the label/description (e.g., "anthropic" for the
 * api-key section). Mirrors Cognia's SETTINGS_SEARCH_INDEX shape.
 */
export const SETTINGS_SEARCH_KEYWORDS: Record<SettingsSectionId, string[]> = {
  general: ["defaults", "model", "system prompt", "permission"],
  "api-key": ["anthropic", "key", "secret", "claude"],
  agents: [
    "external",
    "claude code",
    "claude-code",
    "codex",
    "gemini",
    "cursor",
    "acp",
    "stdio",
    "external agent",
    "外部代理",
  ],
  "agent-modes": [
    "agent mode",
    "custom mode",
    "system prompt",
    "tools",
    "preview",
    "writer",
    "code generator",
    "designer",
    "代理模式",
  ],
  search: [
    "web search",
    "联网搜索",
    "tavily",
    "perplexity",
    "exa",
    "brave",
    "bing",
    "google",
    "serper",
    "serpapi",
    "searchapi",
    "gemini",
    "online",
    "internet",
    "research",
  ],
  appearance: ["theme", "dark", "light", "font", "language"],
  canvas: [
    "canvas",
    "monaco",
    "editor",
    "ai suggestion",
    "autosave",
    "version",
    "diff",
    "collaboration",
    "websocket",
    "execution",
    "sandbox",
    "python",
    "keybinding",
    "accessibility",
    "快捷键",
    "编辑器",
    "版本",
    "协作",
    "执行",
    "沙箱",
    "无障碍",
  ],
  speech: [
    "voice",
    "tts",
    "stt",
    "audio",
    "read aloud",
    "openai",
    "elevenlabs",
    "edge",
    "cartesia",
    "deepgram",
    "lmnt",
    "hume",
    "gemini",
    "speech",
    "语音",
    "朗读",
    "听写",
  ],
  characters: ["persona", "agent"],
  skills: ["skill", "instruction", "prompt", "kit"],
  teams: ["multi-agent", "round-robin", "supervisor"],
  presets: [
    "preset",
    "presets",
    "template",
    "system prompt",
    "persona",
    "snippet",
    "preset library",
    "favorite",
    "default preset",
    "category",
    "预设",
    "模板",
    "系统提示词",
    "收藏",
    "默认",
  ],
  artifacts: [
    "artifact",
    "artifacts",
    "canvas",
    "preview",
    "code",
    "document",
    "auto detect",
    "auto-create",
    "react",
    "html",
    "svg",
    "mermaid",
    "chart",
    "math",
    "jupyter",
    "工件",
    "代码",
    "预览",
  ],
  mcp: ["model context", "stdio", "server", "tool"],
  data: ["export", "import", "backup", "wipe", "indexeddb"],
  "scheduled-tasks": [
    "schedule",
    "scheduler",
    "cron",
    "task",
    "tasks",
    "automation",
    "trigger",
    "interval",
    "timer",
    "定时",
    "调度",
    "任务",
    "自动化",
  ],
  logs: [
    "log",
    "logs",
    "logging",
    "level",
    "transport",
    "retention",
    "sampling",
    "redaction",
    "console",
    "indexeddb",
    "remote",
    "langfuse",
    "opentelemetry",
    "otel",
    "telemetry",
    "observability",
    "可观测",
    "日志",
    "日志级别",
    "采样",
  ],
  diagnostics: [
    "crash",
    "incident",
    "error",
    "diagnostic",
    "diagnostics",
    "stacktrace",
    "trace",
    "fatal",
    "崩溃",
    "诊断",
    "故障",
  ],
  desktop: ["tauri", "tray", "autostart", "window"],
  about: ["version", "build", "credits"],
}

export function isSearchMatch(item: NavItem, query: string, t: (key: string) => string) {
  if (!query.trim()) return true
  const q = query.trim().toLowerCase()
  if (t(`settings.tabs.${item.labelKey}`).toLowerCase().includes(q)) return true
  if (t(`settings.descriptions.${item.descriptionKey}`).toLowerCase().includes(q)) return true
  const keywords = SETTINGS_SEARCH_KEYWORDS[item.id] ?? []
  return keywords.some((k) => k.toLowerCase().includes(q))
}

// Re-export for ergonomic imports.
export { ServerCogIcon }
