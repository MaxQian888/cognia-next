// Settings navigation map — mirrors Cognia's grouped sidebar at
// `D:\Project\Cognia\app\(main)\settings\page.tsx`. Each group maps to a
// section group label (i18n key under `settings.group<Name>`); each item
// maps to a section id used as the URL `?section=` param + the React key.

import type { ComponentType } from "react"
import {
  PaletteIcon,
  UsersIcon,
  SparklesIcon,
  Layers3Icon,
  PuzzleIcon,
  BookmarkIcon,
  FileCode2Icon,
  DatabaseIcon,
  MonitorIcon,
  SquareCodeIcon,
  InfoIcon,
  ServerCogIcon,
  ServerIcon,
  GlobeIcon,
  Volume2Icon,
  ScrollTextIcon,
  BugIcon,
  WalletIcon,
  PlugZapIcon,
  BotIcon,
  ClockIcon,
  PencilRulerIcon,
  WrenchIcon,
  BlocksIcon,
  ArrowLeftRightIcon,
  ShieldCheckIcon,
  ZapIcon,
  BoxesIcon,
  WebhookIcon,
  NetworkIcon,
  TerminalSquareIcon,
  LinkIcon,
  WorkflowIcon,
  SmartphoneIcon,
  MousePointerClickIcon,
  TargetIcon,
  PawPrintIcon,
  MessagesSquareIcon,
  BellIcon,
  PanelsTopLeftIcon,
  CompassIcon,
  BrainIcon,
  GitBranchIcon,
  BracesIcon,
  BoxIcon,
  CircleUserIcon,
  ClipboardCheckIcon,
  KeyboardIcon,
  RadarIcon,
  CableIcon,
} from "lucide-react"

import type { CapabilityId, HostProfile } from "@/lib/platform/capabilities"

export type SettingsGroup = "ai" | "extensions" | "interface" | "data" | "observability" | "system"

export type SettingsSectionId =
  | "general"
  | "account"
  | "profile"
  | "api-key"
  | "providers"
  | "ai-connections"
  | "model-catalog"
  | "ocr"
  | "subscription"
  | "ccswitch"
  | "agents"
  | "agent-modes"
  | "agent-runtime"
  | "squads"
  | "eval"
  | "hooks"
  | "fleet"
  | "workspace-trust"
  | "slash-commands"
  | "tools"
  | "search"
  | "appearance"
  | "sidebar"
  | "discover"
  | "terminal"
  | "source-control"
  | "speech"
  | "characters"
  | "skills"
  | "subagents"
  | "teams"
  | "presets"
  | "chatTemplates"
  | "artifacts"
  | "canvas"
  | "shortcuts"
  | "conversation"
  | "notifications"
  | "memory"
  | "mcp"
  | "a2ui"
  | "plugins"
  | "connections"
  | "services"
  | "data"
  | "workflows"
  | "scheduled-tasks"
  | "goals"
  | "pet"
  | "webhooks"
  | "gateway"
  | "external-bridge"
  | "companion"
  | "remote-hosts"
  | "network"
  | "logs"
  | "diagnostics"
  | "usage-cost"
  | "desktop"
  | "automation"
  | "lsp"
  | "pro-ide"
  | "sandbox"
  | "security"
  | "about"

export interface NavItem {
  id: SettingsSectionId
  /** i18n key under `settings.tabs.<key>`. */
  labelKey: string
  /** i18n key under `settings.descriptions.<key>` — sidebar tooltip. */
  descriptionKey: string
  group: SettingsGroup
  icon: ComponentType<{ className?: string }>
  /**
   * Capabilities the section administers (ADR-0059 D7 / F5). Every one must be
   * available — locally, or server-backed on a companion profile
   * (`capabilityAvailable` semantics, the same rule `CapabilityGate` applies)
   * — for the section to be reachable. A section keyed on capabilities follows
   * its backend to every host that reaches parity, instead of staying hidden
   * behind a host check after the backend already works there.
   */
  requires?: readonly CapabilityId[]
  /**
   * Host profiles the section is bound to. Mirrors `CapabilityGateProps.profiles`:
   * only for surfaces that administer the LOCAL shell process itself (window
   * chrome, tray, this device's pairing endpoints), where a server-backed
   * capability cannot stand in — or, transitionally, where the section's own
   * renderer path still bypasses the transport seam and would throw on any
   * other host (each such pin names the host-parity Class A file it waits on).
   * Combined with `requires`, BOTH must pass.
   */
  profiles?: readonly HostProfile[]
}

/**
 * What a client can reach: its host profile plus a capability check that
 * already folds in server-backed capabilities (`capabilityAvailable`).
 */
export interface SettingsReachabilityContext {
  profile: HostProfile
  hasCapability: (cap: CapabilityId) => boolean
}

/**
 * Whether `item` is reachable from a client described by `ctx`. Pure — the
 * sidebar, the ⌘K finder and the shell's section dispatch all ask this one
 * question so they cannot drift (a section hidden in the sidebar but reachable
 * through a `?section=` deep link only fails at its last IPC call).
 */
export function isSettingsSectionReachable(
  item: Pick<NavItem, "requires" | "profiles">,
  ctx: SettingsReachabilityContext
): boolean {
  if (item.profiles && !item.profiles.includes(ctx.profile)) return false
  return (item.requires ?? []).every((cap) => ctx.hasCapability(cap))
}

/** Every reachable section id for `ctx`, derived from the nav so the two can't drift. */
export function reachableSettingsSections(
  ctx: SettingsReachabilityContext
): ReadonlySet<SettingsSectionId> {
  return new Set(
    SETTINGS_NAV.filter((item) => isSettingsSectionReachable(item, ctx)).map((item) => item.id)
  )
}

export const SETTINGS_NAV: NavItem[] = [
  // === AI ===
  // NOTE: the standalone "general", "api-key", and "profile" sections were
  // merged — general → agent-runtime (defaults/behavior), api-key/providers →
  // ai-connections
  // (Anthropic key + official subscription reuse), and profile → account (the
  // account section already embeds the profile editor). Their ids stay in
  // `SettingsSectionId` + the redirect map in `settings-shell.tsx` (and their
  // keywords are folded into the target section's bucket), but they no longer
  // appear as navigable entries.
  {
    id: "ai-connections",
    labelKey: "aiConnections",
    descriptionKey: "aiConnections",
    group: "ai",
    icon: ServerCogIcon,
  },
  {
    id: "model-catalog",
    labelKey: "modelCatalog",
    descriptionKey: "modelCatalog",
    group: "ai",
    icon: DatabaseIcon,
  },
  {
    id: "ocr",
    labelKey: "ocr",
    descriptionKey: "ocr",
    group: "ai",
    icon: ScrollTextIcon,
  },
  {
    id: "account",
    labelKey: "account",
    descriptionKey: "account",
    group: "ai",
    icon: CircleUserIcon,
  },
  {
    id: "subscription",
    labelKey: "subscription",
    descriptionKey: "subscription",
    group: "ai",
    icon: ZapIcon,
    // The subscription vault lives on the execution host's secret store; a
    // companion client administers the host it is paired to.
    requires: ["keyring"],
  },
  {
    id: "ccswitch",
    labelKey: "ccswitch",
    descriptionKey: "ccswitch",
    group: "ai",
    icon: ArrowLeftRightIcon,
    // Claude Code CLI config on the execution host. Pinned to the desktop for
    // now: `lib/ccswitch/client.ts` and `lib/claude/settings.ts` still import
    // `invoke` from `@tauri-apps/api/core` (host-parity Class A) and would
    // throw on any other host — lift the pin when they move onto the seam.
    requires: ["shell"],
    profiles: ["desktop"],
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
    id: "agent-runtime",
    labelKey: "agentRuntime",
    descriptionKey: "agentRuntime",
    group: "ai",
    icon: WorkflowIcon,
  },
  {
    id: "squads",
    labelKey: "squads",
    descriptionKey: "squads",
    group: "ai",
    icon: Layers3Icon,
  },
  {
    id: "eval",
    labelKey: "eval",
    descriptionKey: "eval",
    group: "ai",
    icon: ClipboardCheckIcon,
  },
  {
    id: "hooks",
    labelKey: "hooks",
    descriptionKey: "hooks",
    group: "ai",
    icon: WebhookIcon,
    // Agent lifecycle hooks run in the sidecar on the execution host. Pinned
    // to the desktop until `lib/claude/settings.ts` (raw `invoke`, host-parity
    // Class A) moves onto the transport seam.
    requires: ["sidecar"],
    profiles: ["desktop"],
  },
  {
    id: "fleet",
    labelKey: "fleet",
    descriptionKey: "fleet",
    group: "ai",
    icon: RadarIcon,
    // Pinned to the desktop until `lib/tauri/fleet.ts` and
    // `lib/claude/hooks/fleet-hooks.ts` (raw `invoke`, host-parity Class A)
    // move onto the transport seam.
    requires: ["shell"],
    profiles: ["desktop"],
  },
  {
    id: "workspace-trust",
    labelKey: "workspaceTrust",
    descriptionKey: "workspaceTrust",
    group: "ai",
    icon: ShieldCheckIcon,
    // Trust decisions about workspaces on the execution host's filesystem.
    requires: ["shell"],
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
    // Tool policy for the agent runtime on the execution host.
    requires: ["sidecar"],
  },
  {
    id: "search",
    labelKey: "search",
    descriptionKey: "search",
    group: "ai",
    icon: GlobeIcon,
  },
  {
    id: "lsp",
    labelKey: "lsp",
    descriptionKey: "lsp",
    group: "ai",
    icon: BracesIcon,
    // Language servers are spawned on the execution host.
    requires: ["shell"],
  },
  {
    id: "sandbox",
    labelKey: "sandbox",
    descriptionKey: "sandbox",
    group: "ai",
    icon: BoxIcon,
    // Sandbox confinement for processes the execution host spawns.
    requires: ["shell"],
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
  {
    id: "connections",
    labelKey: "connections",
    descriptionKey: "connections",
    group: "extensions",
    icon: LinkIcon,
    // IM connector adapters run wherever the connector runtime does — the
    // desktop, or the cloud brain a companion is paired to (ADR-0059 F4).
    requires: ["connector-runtime"],
  },
  {
    id: "services",
    labelKey: "externalServices",
    descriptionKey: "externalServices",
    group: "extensions",
    icon: CableIcon,
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
    // Id kept as `sidebar` so `/settings?section=sidebar` deep links survive;
    // the section now covers the nav rail plus both window bars.
    id: "sidebar",
    labelKey: "shellLayout",
    descriptionKey: "shellLayout",
    group: "interface",
    icon: PanelsTopLeftIcon,
    // Customises the local desktop shell chrome (nav rail, top and bottom
    // bars) — a local-shell surface, not a capability question.
    profiles: ["desktop"],
  },
  {
    id: "discover",
    labelKey: "discover",
    descriptionKey: "discover",
    group: "interface",
    icon: CompassIcon,
    // Pure preferences for the Discover surface, which every shell renders;
    // the old desktop pin was an unmigrated UI assumption.
  },
  {
    id: "speech",
    labelKey: "speech",
    descriptionKey: "speech",
    group: "interface",
    icon: Volume2Icon,
  },
  {
    id: "terminal",
    labelKey: "terminal",
    descriptionKey: "terminal",
    group: "interface",
    icon: TerminalSquareIcon,
    // Terminal sessions run against the execution host's PTYs.
    requires: ["pty"],
  },
  {
    id: "presets",
    labelKey: "presets",
    descriptionKey: "presets",
    group: "interface",
    icon: BookmarkIcon,
  },
  {
    id: "chatTemplates",
    labelKey: "chatTemplates",
    descriptionKey: "chatTemplates",
    group: "interface",
    icon: FileCode2Icon,
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
  {
    id: "shortcuts",
    labelKey: "shortcuts",
    descriptionKey: "shortcuts",
    group: "interface",
    icon: KeyboardIcon,
  },
  {
    id: "source-control",
    labelKey: "sourceControl",
    descriptionKey: "sourceControl",
    group: "interface",
    icon: GitBranchIcon,
    // Git runs on the execution host (source-control.git host feature).
    requires: ["shell"],
  },
  {
    id: "pro-ide",
    labelKey: "proIde",
    descriptionKey: "proIde",
    group: "interface",
    icon: SquareCodeIcon,
    // code-server is brokered on the execution host (ADR-0088).
    requires: ["shell"],
  },
  {
    id: "conversation",
    labelKey: "conversation",
    descriptionKey: "conversation",
    group: "interface",
    icon: MessagesSquareIcon,
  },
  {
    id: "notifications",
    labelKey: "notifications",
    descriptionKey: "notifications",
    group: "interface",
    icon: BellIcon,
  },
  {
    id: "memory",
    labelKey: "memory",
    descriptionKey: "memory",
    group: "ai",
    icon: BrainIcon,
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
    id: "workflows",
    labelKey: "workflows",
    descriptionKey: "workflows",
    group: "data",
    icon: WorkflowIcon,
  },
  {
    id: "scheduled-tasks",
    labelKey: "scheduledTasks",
    descriptionKey: "scheduledTasks",
    group: "data",
    icon: ClockIcon,
  },
  {
    id: "goals",
    labelKey: "goals",
    descriptionKey: "goals",
    group: "data",
    icon: TargetIcon,
  },
  {
    id: "pet",
    labelKey: "pet",
    descriptionKey: "pet",
    group: "data",
    icon: PawPrintIcon,
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
  {
    id: "usage-cost",
    labelKey: "usageCost",
    descriptionKey: "usageCost",
    group: "observability",
    icon: WalletIcon,
  },

  // === System ===
  {
    id: "webhooks",
    labelKey: "webhooks",
    descriptionKey: "webhooks",
    group: "system",
    icon: WebhookIcon,
    // Webhook delivery needs a process that outlives the page.
    requires: ["always-on"],
  },
  {
    id: "gateway",
    labelKey: "gateway",
    descriptionKey: "gateway",
    group: "system",
    icon: NetworkIcon,
    // The inbound LLM gateway is a long-lived listener on the execution host.
    requires: ["always-on"],
  },
  {
    id: "external-bridge",
    labelKey: "externalBridge",
    descriptionKey: "externalBridge",
    group: "system",
    icon: WebhookIcon,
  },
  {
    id: "automation",
    labelKey: "automation",
    descriptionKey: "automation",
    group: "system",
    icon: MousePointerClickIcon,
    // Desktop UI automation is a recorded physical boundary — the capability
    // is never server-backed, so companion profiles do not see this section.
    requires: ["uia-automation"],
  },
  {
    id: "companion",
    labelKey: "companion",
    descriptionKey: "companion",
    group: "system",
    icon: SmartphoneIcon,
    // Administers THIS device's companion server (mDNS, tunnel, TLS
    // fingerprint, push credentials) — a local-shell surface. Remote hosts are
    // administered from Remote hosts / Connections instead.
    profiles: ["desktop"],
  },
  {
    id: "remote-hosts",
    labelKey: "remoteHosts",
    descriptionKey: "remoteHosts",
    group: "system",
    icon: ServerIcon,
    // The desktop's registry of remote hosts that may drive the app
    // (ADR-0082 R0); web clients pair through `/pair` instead.
    profiles: ["desktop"],
  },
  {
    id: "network",
    labelKey: "network",
    descriptionKey: "network",
    group: "system",
    icon: NetworkIcon,
  },
  {
    id: "desktop",
    labelKey: "desktop",
    descriptionKey: "desktop",
    group: "system",
    icon: MonitorIcon,
    // Window chrome, close behaviour, tray and global hotkeys — recorded
    // physical boundaries of the desktop shell.
    profiles: ["desktop"],
  },
  {
    id: "security",
    labelKey: "security",
    descriptionKey: "security",
    group: "system",
    icon: ShieldCheckIcon,
    // Biometric guard policy toggles; the guard itself degrades per device,
    // and the mobile sign-out toggle only means anything off the desktop.
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
export const SETTINGS_SEARCH_KEYWORDS: Partial<Record<SettingsSectionId, string[]>> = {
  account: [
    "account",
    "overview",
    "identity",
    "profile",
    "subscription",
    "devices",
    // folded from the merged "profile" section (see SETTINGS_NAV note)
    "name",
    "avatar",
    "bio",
    "timezone",
    "账户",
    "账号",
    "概览",
    "身份",
    "资料",
    "昵称",
    "头像",
    "时区",
  ],
  "ai-connections": [
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
    // Absorbed from the former standalone "api-key" section.
    "key",
    "secret",
    "claude",
  ],
  "model-catalog": [
    "models",
    "canonical id",
    "upstream id",
    "alias",
    "offering",
    "capabilities",
    "lifecycle",
    "deprecated",
    "embedding",
    "rerank",
    "image",
    "speech",
    "模型目录",
    "能力",
    "生命周期",
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
  subscription: [
    "subscription",
    "claude",
    "anthropic",
    "pro",
    "max",
    "oauth",
    "pkce",
    "sign in",
    "login",
    "rate limit",
    "ratelimit",
    "5 hour",
    "7 day",
    "quota",
    "usage",
    "codex",
    "openai",
    "chatgpt",
    "plus",
    "device code",
    "reuse",
    "opencode",
    "opencode-zen",
    "zen",
    "vault",
    "multi account",
    "multi-account",
    "preset",
    "bedrock",
    "azure",
    "openrouter",
    "passphrase",
    "export",
    "import",
    "backup",
    "订阅",
    "限额",
    "用量",
    "登录",
    "授权",
    "复用",
    "OpenAI 订阅",
    "OpenCode",
    "多账号",
    "预设",
    "备份",
    "恢复",
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
  "agent-runtime": [
    "agent runtime",
    "built-in agent",
    "builtin agent",
    "sidecar",
    "permission mode",
    "always allow",
    "builtin tools",
    "a2ui bridge",
    "routing fallback",
    "default model",
    "default system prompt",
    "working directory",
    "内置代理",
    "代理运行时",
    "侧载",
    "路由回退",
    "始终允许",
    "权限模式",
    "默认模型",
    // Absorbed from the former standalone "general" section.
    "defaults",
    "system prompt",
    "output style",
    "bare mode",
    "brief mode",
    "输出风格",
    "极简模式",
    "简短输出",
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
  ocr: [
    "ocr",
    "image",
    "pdf",
    "extract text",
    "tesseract",
    "mistral ocr",
    "google vision",
    "aws textract",
    "azure document",
    "mathpix",
    "abbyy",
    "nanonets",
    "windows ocr",
    "apple vision",
    "ml kit",
    "feishu",
    "lark",
    "光学字符识别",
    "图片识别",
    "扫描",
    "PDF 文字",
    "识别图片文字",
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
  sidebar: [
    "sidebar",
    "rail",
    "guild rail",
    "navigation",
    "nav",
    "pin",
    "pinned",
    "reorder",
    "customize",
    "hide",
    "more",
    "overflow",
    "title bar",
    "top bar",
    "status bar",
    "bottom bar",
    "layout",
    "chrome",
    "侧边栏",
    "导航",
    "固定",
    "自定义",
    "排序",
    "隐藏",
    "顶部栏",
    "标题栏",
    "底部栏",
    "状态栏",
    "布局",
  ],
  discover: [
    "discover",
    "categories",
    "category",
    "favorites",
    "pin",
    "reorder",
    "hide",
    "view",
    "grid",
    "发现",
    "分类",
    "收藏",
    "置顶",
    "排序",
    "隐藏",
    "视图",
  ],
  terminal: [
    "terminal",
    "shell",
    "pty",
    "bash",
    "zsh",
    "pwsh",
    "powershell",
    "xterm",
    "ConPTY",
    "scrollback",
    "shell integration",
    "OSC 633",
    "vscode terminal",
    "ssh",
    "集成终端",
    "命令行",
    "终端",
    "外壳",
  ],
  conversation: [
    "conversation",
    "title",
    "auto title",
    "auto-generate title",
    "session name",
    "rename",
    "timeline",
    "minimap",
    "navigation",
    "jump",
    "对话标题",
    "自动标题",
    "会话标题",
    "时间线",
    "缩略图",
    "导航",
    "跳转",
  ],
  notifications: [
    "notifications",
    "notification center",
    "alerts",
    "toast",
    "desktop notification",
    "push",
    "quiet hours",
    "do not disturb",
    "dnd",
    "snooze",
    "mute",
    "badge",
    "retention",
    "通知",
    "通知中心",
    "提醒",
    "桌面通知",
    "推送",
    "安静时段",
    "勿扰",
    "静音",
    "角标",
    "保留",
  ],
  shortcuts: [
    "shortcut",
    "shortcuts",
    "hotkey",
    "hotkeys",
    "keybinding",
    "keybindings",
    "keyboard",
    "accelerator",
    "global shortcut",
    "rebind",
    "conflict",
    "快捷键",
    "热键",
    "键位",
    "键盘",
    "组合键",
    "冲突",
  ],
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
  chatTemplates: [
    "chat template",
    "chat templates",
    "message template",
    "saved message",
    "parameter",
    "parameters",
    "placeholder",
    "snippet",
    "reusable message",
    "会话模板",
    "消息模板",
    "模板",
    "参数",
    "占位符",
    "常用语",
  ],
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
  memory: ["memory", "long-term", "remember", "recall", "facts", "记忆", "preferences"],
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
  workflows: [
    "workflow",
    "workflows",
    "automation",
    "orchestration",
    "n8n",
    "trigger",
    "node",
    "graph",
    "flow",
    "pipeline",
    "工作流",
    "编排",
    "自动化",
    "流程",
    "可视化",
    "节点",
  ],
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
  goals: [
    "goal",
    "goals",
    "objective",
    "objectives",
    "loop",
    "continuation",
    "autonomous",
    "judge",
    "目标",
    "目的",
    "循环",
    "持续",
    "判官",
  ],
  pet: ["pet", "mascot", "companion", "buddy", "宠物", "桌宠", "伙伴"],
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
  "usage-cost": [
    "usage",
    "cost",
    "spend",
    "spending",
    "budget",
    "limit",
    "quota",
    "billing",
    "price",
    "pricing",
    "usd",
    "debug session",
    "trace debug",
    "用量",
    "成本",
    "花费",
    "预算",
    "上限",
    "配额",
    "计费",
    "调试会话",
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
    // Developer flags relocated from the former "general" section.
    "debug",
    "debug mode",
    "chat middleware",
    "调试",
    "中间件",
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
  fleet: [
    "fleet",
    "agent fleet",
    "monitor",
    "island",
    "overlay",
    "claude code",
    "codex",
    "opencode",
    "external agent",
    "session history",
    "舰队",
    "监控",
    "灵动岛",
    "悬浮层",
    "外部 Agent",
    "会话历史",
  ],
  "workspace-trust": [
    "trust",
    "workspace",
    "restricted",
    "security",
    "folder",
    "信任",
    "工作区",
    "受限",
    "安全",
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
  squads: [
    "squad",
    "squads",
    "小队",
    "team",
    "teams",
    "multi-agent",
    "supervisor",
    "round-robin",
    "agent team",
    "团队",
    "多代理",
  ],
  eval: [
    "eval",
    "evals",
    "evaluation",
    "agent eval",
    "judge",
    "judge model",
    "scorer",
    "scorers",
    "pass@1",
    "pass^k",
    "gate",
    "threshold",
    "calibration",
    "dataset",
    "benchmark",
    "deterministic",
    "评估",
    "评测",
    "评委",
    "评分器",
    "门限",
    "校准",
    "数据集",
    "基准",
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
    "plugin config",
    "plugin settings",
    "configure plugin",
    "plugin configuration",
    "插件",
    "扩展",
    "市场",
    "插件配置",
    "插件设置",
  ],
  connections: [
    "connections",
    "platform",
    "connector",
    "connectors",
    "telegram",
    "discord",
    "slack",
    "lark",
    "onebot",
    "messaging",
    "adapter",
    "adapters",
    "bot",
    "webhook",
    "longpoll",
    "outbound",
    "audit",
    "平台连接",
    "消息平台",
    "机器人",
    "适配器",
  ],
  services: [
    "external services",
    "saas",
    "website",
    "openapi",
    "mcp",
    "integration",
    "connector",
    "外部服务",
    "网站连接",
  ],
  webhooks: ["webhook", "outbound", "standard webhooks", "signing", "egress", "出站", "签名"],
  gateway: [
    "gateway",
    "openai",
    "anthropic",
    "base url",
    "proxy",
    "claude code",
    "/v1/chat/completions",
    "/v1/messages",
    "网关",
    "入站",
    "代理",
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
  automation: [
    "automation",
    "ui automation",
    "desktop automation",
    "uia",
    "screenshot",
    "click",
    "type",
    "computer use",
    "桌面自动化",
    "界面自动化",
    "无障碍",
  ],
  companion: [
    "mobile",
    "phone",
    "qr",
    "pair",
    "ios",
    "android",
    "companion",
    "device",
    "lan",
    "手机",
    "配对",
    "扫码",
    "移动端",
  ],
  "remote-hosts": [
    "remote",
    "remote host",
    "remote development",
    "remote dev",
    "ssh",
    "dev box",
    "cognia-server",
    "terminal",
    "pair",
    "远程",
    "远程主机",
    "远程开发",
    "配对",
  ],
  network: [
    "network",
    "proxy",
    "http proxy",
    "https proxy",
    "socks",
    "socks5",
    "clash",
    "clash verge",
    "mihomo",
    "v2ray",
    "shadowsocks",
    "代理",
    "网络代理",
    "翻墙",
    "fanqiang",
    "internet",
    "outbound",
  ],
  desktop: ["tauri", "tray", "autostart", "window"],
  about: ["version", "build", "credits"],
  "source-control": [
    "git",
    "source control",
    "commit",
    "commit message",
    "ai commit",
    "conventional commits",
    "diff",
    "branch",
    "源代码管理",
    "提交",
    "提交信息",
    "分支",
  ],
  "pro-ide": [
    "pro ide",
    "code-server",
    "codeserver",
    "vs code",
    "vscode",
    "editor engine",
    "embedded editor",
    "编辑器引擎",
    "内嵌编辑器",
  ],
  lsp: [
    "lsp",
    "language server",
    "language server protocol",
    "typescript",
    "pyright",
    "rust-analyzer",
    "gopls",
    "intellisense",
    "diagnostics",
    "语言服务器",
    "代码补全",
    "诊断",
  ],
  sandbox: [
    "sandbox",
    "isolation",
    "microvm",
    "os sandbox",
    "tool safety",
    "strict mode",
    "execution policy",
    "沙箱",
    "隔离",
    "执行策略",
    "安全",
  ],
  security: [
    "security",
    "privacy",
    "biometric",
    "touch id",
    "face id",
    "windows hello",
    "guard",
    "reveal secrets",
    "sign out",
    "安全",
    "隐私",
    "生物识别",
    "指纹",
    "面容",
  ],
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
