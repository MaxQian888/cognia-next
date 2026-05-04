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
  WrenchIcon,
  BlocksIcon,
  ArrowLeftRightIcon,
  RadioTowerIcon,
  BoxesIcon,
  WebhookIcon,
  NetworkIcon,
  TerminalSquareIcon,
} from "lucide-react"

export type SettingsGroup = "ai" | "extensions" | "interface" | "data" | "observability" | "system"

export type SettingsSectionId =
  | "general"
  | "api-key"
  | "providers"
  | "ccswitch"
  | "agents"
  | "agent-modes"
  | "agent-teams"
  | "hooks"
  | "slash-commands"
  | "tools"
  | "search"
  | "appearance"
  | "speech"
  | "characters"
  | "skills"
  | "subagents"
  | "teams"
  | "presets"
  | "artifacts"
  | "canvas"
  | "mcp"
  | "a2ui"
  | "plugins"
  | "data"
  | "scheduled-tasks"
  | "remote-control"
  | "external-bridge"
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
    id: "providers",
    labelKey: "providers",
    descriptionKey: "providers",
    group: "ai",
    icon: ServerCogIcon,
  },
  {
    id: "ccswitch",
    labelKey: "ccswitch",
    descriptionKey: "ccswitch",
    group: "ai",
    icon: ArrowLeftRightIcon,
    desktopOnly: true,
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
    id: "agent-teams",
    labelKey: "agentTeams",
    descriptionKey: "agentTeams",
    group: "ai",
    icon: Layers3Icon,
  },
  {
    id: "hooks",
    labelKey: "hooks",
    descriptionKey: "hooks",
    group: "ai",
    icon: WebhookIcon,
    desktopOnly: true,
  },
  {
    id: "slash-commands",
    labelKey: "slashCommands",
    descriptionKey: "slashCommands",
    group: "ai",
    icon: TerminalSquareIcon,
  },
  {
    id: "tools",
    labelKey: "tools",
    descriptionKey: "tools",
    group: "ai",
    icon: WrenchIcon,
    desktopOnly: true,
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
    id: "subagents",
    labelKey: "subagents",
    descriptionKey: "subagents",
    group: "extensions",
    icon: NetworkIcon,
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
  {
    id: "a2ui",
    labelKey: "a2ui",
    descriptionKey: "a2ui",
    group: "extensions",
    icon: BlocksIcon,
  },
  {
    id: "plugins",
    labelKey: "plugins",
    descriptionKey: "plugins",
    group: "extensions",
    icon: BoxesIcon,
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
    id: "remote-control",
    labelKey: "remoteControl",
    descriptionKey: "remoteControl",
    group: "system",
    icon: RadioTowerIcon,
    desktopOnly: true,
  },
  {
    id: "external-bridge",
    labelKey: "externalBridge",
    descriptionKey: "externalBridge",
    group: "system",
    icon: WebhookIcon,
  },
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
  providers: [
    "providers",
    "openai",
    "anthropic",
    "google",
    "gemini",
    "mistral",
    "ollama",
    "openrouter",
    "deepseek",
    "groq",
    "cohere",
    "api key",
    "base url",
    "custom provider",
    "model list",
  ],
  ccswitch: [
    "cc-switch",
    "ccswitch",
    "subscription",
    "provider",
    "switch",
    "kimi",
    "deepseek",
    "moonshot",
    "qwen",
    "订阅",
    "切换",
    "供应商",
    "服务商",
  ],
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
  tools: [
    "tools",
    "builtin",
    "built-in",
    "shell",
    "filesystem",
    "file system",
    "git",
    "process",
    "environment",
    "always allow",
    "approval",
    "工具",
    "内置工具",
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
  a2ui: [
    "a2ui",
    "agent ui",
    "agent-to-ui",
    "mini-app",
    "mini-apps",
    "interactive",
    "surface",
    "widget",
    "a2ui-bridge",
    "小应用",
    "代理界面",
  ],
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
  hooks: [
    "hook",
    "hooks",
    "lifecycle",
    "trigger",
    "webhook",
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "matcher",
    "钩子",
    "回调",
    "触发",
    "生命周期",
  ],
  "slash-commands": [
    "slash",
    "command",
    "/cost",
    "/help",
    "/clear",
    "/compact",
    "/init",
    "plugin command",
    "shortcut",
    "斜杠",
    "命令",
    "快捷",
  ],
  subagents: [
    "subagent",
    "sub-agent",
    "sub agent",
    "child agent",
    "spawn",
    "delegate",
    "parallel",
    "research",
    "code review",
    "子代理",
    "子智能体",
    "派发",
    "并行",
  ],
  "agent-teams": [
    "team",
    "teams",
    "multi-agent",
    "supervisor",
    "round-robin",
    "agent team",
    "团队",
    "多代理",
  ],
  plugins: [
    "plugin",
    "plugins",
    "extension",
    "marketplace",
    "permissions",
    "scheduled",
    "audit",
    "diagnostics",
    "插件",
    "扩展",
    "市场",
  ],
  "remote-control": [
    "remote",
    "webhook",
    "remote-control",
    "inbound",
    "outbound",
    "control",
    "trigger",
    "远程控制",
    "外部触发",
  ],
  "external-bridge": [
    "external-bridge",
    "external bridge",
    "mcp",
    "mcp server",
    "wiki",
    "claude code",
    "cursor",
    "cline",
    "外部桥接",
    "插件桥",
    "知识对外",
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
