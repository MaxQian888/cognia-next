/**
 * Declarative i18n bundle (ADR-0026 §5 §D). The plugin manager auto-wires
 * `manifest.i18n.locales` on enable and tears it down on disable. Keys here
 * are UNPREFIXED — the manager stamps `plugin.<pluginId>.` onto each key when
 * it merges the bundle into the host registry (manager.ts), so a
 * `plugin.<id>.*` prefix here would double-prefix into a namespace nothing
 * can resolve. Plugin bundles do NOT touch `i18n/messages/{en,zh-CN}.json`,
 * so the host `lint:i18n` baseline is unaffected.
 *
 * Pack / role / skill / template display names are plain strings on their defs
 * (the consuming pickers read those fields directly, not i18n keys). This
 * bundle covers the plugin-owned status / command text only — read it via
 * `ctx.i18n.t(key)` (host path) or `usePluginT` (component path).
 */

export const I18N_MESSAGES = {
  en: {
    activated:
      "Zhihu Content Pipeline registered: five role characters (Scout / Editor / Researcher / Writer / Polisher), Zhihu writing skills, and MCP presets (zget, Exa, Fetch, Sequential Thinking, CloakBrowser). Enable the MCP servers you need, then chat with a role.",
    "review.title": "Zhihu Pipeline — Review",
    "review.candidates": "Candidate topics",
    "review.drafts": "Saved drafts",
    "review.empty": "No candidate topics yet. Run the “知乎选题候选” workflow first.",
    "review.draftsEmpty": "No drafts saved yet.",
    "review.startWriting": "Start writing",
    "review.startWritingAria": "Start writing for: {title}",
    "review.close": "Close",
    "review.loading": "Loading…",
    "command.opened": "Opened the Zhihu topic review panel.",
    "command.noModal": "The current environment does not support modal panels.",
  },
  "zh-CN": {
    activated:
      "知乎内容流水线已注册：五个角色（侦察/选题/调研/写手/润色）、知乎写作 skills，以及 MCP 预设（zget、Exa、Fetch、Sequential Thinking、CloakBrowser）。按需启用 MCP 服务器后，与对应角色聊天即可。",
    "review.title": "知乎流水线 — 审阅",
    "review.candidates": "候选选题",
    "review.drafts": "已存草稿",
    "review.empty": "还没有候选选题。先运行「知乎选题候选」工作流。",
    "review.draftsEmpty": "还没有草稿。",
    "review.startWriting": "开始写作",
    "review.startWritingAria": "开始写作：{title}",
    "review.close": "关闭",
    "review.loading": "加载中…",
    "command.opened": "已打开知乎选题审阅面板。",
    "command.noModal": "当前环境不支持弹窗面板。",
  },
} as const
