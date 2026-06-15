/**
 * Control-level finder registry.
 *
 * The settings sidebar search filters *sections*; this registry adds *control*
 * granularity so a search can jump straight to a specific setting and highlight
 * it. It is a deliberately curated subset of high-traffic controls — NOT every
 * control in the app. Adding an entry here makes a control findable; adding a
 * matching `data-setting-id="<id>"` anchor in its section makes the jump also
 * scroll-and-highlight (otherwise the finder degrades to section-level).
 *
 * Labels are localized under `settings.finder.controls.<id>`; `keywords` are
 * match-only tokens (never displayed) so plain bilingual strings are fine here.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"

export interface SettingControl {
  /** Stable id; doubles as the `?focus=` value and `data-setting-id` anchor. */
  id: string
  sectionId: SettingsSectionId
  /** i18n key under `settings.finder.controls.<id>`. */
  labelKey: string
  /** Extra match tokens (not displayed). */
  keywords?: string[]
  /** The AppSettings key this control edits, when 1:1. */
  settingKey?: keyof AppSettings
}

export const SETTING_CONTROLS: SettingControl[] = [
  // general
  {
    id: "default-model",
    sectionId: "general",
    labelKey: "defaultModel",
    settingKey: "defaultModel",
    keywords: ["model", "默认模型", "llm"],
  },
  {
    id: "permission-mode",
    sectionId: "general",
    labelKey: "permissionMode",
    settingKey: "permissionMode",
    keywords: ["permission", "权限", "yolo", "accept edits", "plan"],
  },
  {
    id: "language",
    sectionId: "appearance",
    labelKey: "language",
    settingKey: "language",
    keywords: ["language", "语言", "locale", "中文", "english"],
  },
  {
    id: "default-working-dir",
    sectionId: "general",
    labelKey: "workingDir",
    settingKey: "defaultWorkingDir",
    keywords: ["working directory", "cwd", "工作目录"],
  },
  // appearance (behind tabs → section-level jump)
  {
    id: "theme",
    sectionId: "appearance",
    labelKey: "theme",
    settingKey: "theme",
    keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
  },
  {
    id: "font-scale",
    sectionId: "appearance",
    labelKey: "fontScale",
    settingKey: "fontScale",
    keywords: ["font", "size", "字体", "字号"],
  },
  {
    id: "reduce-motion",
    sectionId: "appearance",
    labelKey: "reduceMotion",
    settingKey: "reduceMotion",
    keywords: ["motion", "animation", "动画", "减少动效", "accessibility"],
  },
  {
    id: "custom-css",
    sectionId: "appearance",
    labelKey: "customCss",
    settingKey: "customCss",
    keywords: ["css", "custom", "自定义样式"],
  },
  // search
  {
    id: "search-enabled",
    sectionId: "search",
    labelKey: "searchEnabled",
    settingKey: "searchEnabled",
    keywords: ["web search", "搜索"],
  },
  {
    id: "default-search-provider",
    sectionId: "search",
    labelKey: "searchProvider",
    settingKey: "defaultSearchProvider",
    keywords: ["tavily", "exa", "brave", "搜索引擎"],
  },
  // speech
  {
    id: "tts-enabled",
    sectionId: "speech",
    labelKey: "ttsEnabled",
    settingKey: "ttsEnabled",
    keywords: ["text to speech", "voice", "语音", "朗读"],
  },
  {
    id: "tts-provider",
    sectionId: "speech",
    labelKey: "ttsProvider",
    settingKey: "ttsProvider",
    keywords: ["openai", "elevenlabs", "edge", "语音引擎"],
  },
  // tools
  {
    id: "builtin-tools",
    sectionId: "tools",
    labelKey: "builtinTools",
    settingKey: "builtinTools",
    keywords: ["tools", "bash", "files", "工具"],
  },
  {
    id: "web-tools",
    sectionId: "tools",
    labelKey: "webTools",
    settingKey: "webTools",
    keywords: ["web fetch", "web search tool", "网页工具"],
  },
  // agent-runtime
  {
    id: "subagent-nesting",
    sectionId: "agent-runtime",
    labelKey: "subagentNesting",
    settingKey: "subagentNesting",
    keywords: ["nesting", "depth", "子代理", "嵌套"],
  },
  // network
  {
    id: "network-proxy",
    sectionId: "network",
    labelKey: "networkProxy",
    settingKey: "networkProxy",
    keywords: ["proxy", "socks", "http proxy", "代理"],
  },
  // security
  {
    id: "biometric-guard",
    sectionId: "security",
    labelKey: "biometricGuard",
    settingKey: "biometricRequiredFor",
    keywords: ["biometric", "touch id", "face id", "生物识别", "指纹"],
  },
  // sandbox
  {
    id: "sandbox-enabled",
    sectionId: "sandbox",
    labelKey: "sandboxEnabled",
    settingKey: "sandboxDefaultEnabled",
    keywords: ["sandbox", "isolation", "沙箱"],
  },
  // conversation
  {
    id: "conversation-title",
    sectionId: "conversation",
    labelKey: "conversationTitle",
    settingKey: "conversationTitle",
    keywords: ["auto title", "标题", "命名"],
  },
  // notifications
  {
    id: "notifications",
    sectionId: "notifications",
    labelKey: "notifications",
    settingKey: "notificationPreferences",
    keywords: ["notification", "dnd", "quiet hours", "通知", "免打扰"],
  },
  // data
  {
    id: "telemetry",
    sectionId: "data",
    labelKey: "telemetry",
    settingKey: "telemetryEnabled",
    keywords: ["telemetry", "analytics", "遥测", "统计"],
  },
  // about
  {
    id: "auto-update",
    sectionId: "about",
    labelKey: "autoUpdate",
    settingKey: "updates",
    keywords: ["update", "auto check", "更新", "自动检查"],
  },
]
