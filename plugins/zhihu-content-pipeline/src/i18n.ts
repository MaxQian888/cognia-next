/**
 * Declarative i18n bundle (ADR-0026 §5 §D). The plugin manager auto-wires
 * `manifest.i18n.locales` on enable and tears it down on disable; keys resolve
 * as `plugin.<pluginId>.<key>` at render time. Plugin bundles do NOT touch
 * `i18n/messages/{en,zh-CN}.json`, so the host `lint:i18n` baseline is
 * unaffected (mirrors `cognia-backend-refactor/src/i18n.ts`).
 *
 * Pack / role / skill / template display names are plain strings on their defs
 * (the consuming pickers read those fields directly, not i18n keys). This
 * bundle covers the plugin-owned status / setup text only.
 */

export const I18N_MESSAGES = {
  en: {
    "plugin.zhihu-content-pipeline.activated":
      "Zhihu Content Pipeline registered: five role characters (Scout / Editor / Researcher / Writer / Polisher), Zhihu writing skills, and MCP presets (zget, Exa, Fetch, Sequential Thinking, CloakBrowser). Enable the MCP servers you need, then chat with a role.",
    "plugin.zhihu-content-pipeline.setup.title": "Zhihu Pipeline — Setup",
    "plugin.zhihu-content-pipeline.setup.intro":
      "This plugin drives external tools. Install the ones you need, then enable their MCP servers from the gallery.",
    "plugin.zhihu-content-pipeline.setup.zget":
      "zget CLI — content + hot topics + draft publishing. Install: npm i -g zget-cli, then run `zget login` once.",
    "plugin.zhihu-content-pipeline.setup.exa":
      "Exa MCP — web search & fetch. Needs an EXA_API_KEY.",
    "plugin.zhihu-content-pipeline.setup.cloak":
      "CloakBrowser — human-like stealth browser. Install: pip install cloakbrowser, run `cloakserve` and paste its CDP endpoint.",
    "plugin.zhihu-content-pipeline.setup.ok": "Found",
    "plugin.zhihu-content-pipeline.setup.missing": "Not found",
    "plugin.zhihu-content-pipeline.setup.recheck": "Re-check dependencies",
    "plugin.zhihu-content-pipeline.review.title": "Zhihu Pipeline — Review",
    "plugin.zhihu-content-pipeline.review.candidates": "Candidate topics",
    "plugin.zhihu-content-pipeline.review.drafts": "Saved drafts",
    "plugin.zhihu-content-pipeline.review.empty":
      "No candidate topics yet. Run the “知乎选题候选” workflow first.",
    "plugin.zhihu-content-pipeline.review.draftsEmpty": "No drafts saved yet.",
    "plugin.zhihu-content-pipeline.review.startWriting": "Start writing",
    "plugin.zhihu-content-pipeline.review.startWritingAria": "Start writing for: {title}",
    "plugin.zhihu-content-pipeline.review.close": "Close",
    "plugin.zhihu-content-pipeline.review.loading": "Loading…",
    "plugin.zhihu-content-pipeline.command.opened": "已打开知乎选题审阅面板。",
    "plugin.zhihu-content-pipeline.command.noModal": "当前环境不支持弹窗面板。",
  },
  "zh-CN": {
    "plugin.zhihu-content-pipeline.activated":
      "知乎内容流水线已注册：五个角色（侦察/选题/调研/写手/润色）、知乎写作 skills，以及 MCP 预设（zget、Exa、Fetch、Sequential Thinking、CloakBrowser）。按需启用 MCP 服务器后，与对应角色聊天即可。",
    "plugin.zhihu-content-pipeline.setup.title": "知乎流水线 — 安装检查",
    "plugin.zhihu-content-pipeline.setup.intro":
      "本插件驱动外部工具。按需安装后，在 MCP 库里启用对应服务器。",
    "plugin.zhihu-content-pipeline.setup.zget":
      "zget CLI — 取内容 + 热榜 + 发草稿。安装：npm i -g zget-cli，并运行一次 `zget login`。",
    "plugin.zhihu-content-pipeline.setup.exa": "Exa MCP — 联网搜索与抓取。需要 EXA_API_KEY。",
    "plugin.zhihu-content-pipeline.setup.cloak":
      "CloakBrowser — 拟人化隐身浏览器。安装：pip install cloakbrowser，运行 `cloakserve` 后粘贴其 CDP 地址。",
    "plugin.zhihu-content-pipeline.setup.ok": "已找到",
    "plugin.zhihu-content-pipeline.setup.missing": "未找到",
    "plugin.zhihu-content-pipeline.setup.recheck": "重新检查依赖",
    "plugin.zhihu-content-pipeline.review.title": "知乎流水线 — 审阅",
    "plugin.zhihu-content-pipeline.review.candidates": "候选选题",
    "plugin.zhihu-content-pipeline.review.drafts": "已存草稿",
    "plugin.zhihu-content-pipeline.review.empty": "还没有候选选题。先运行「知乎选题候选」工作流。",
    "plugin.zhihu-content-pipeline.review.draftsEmpty": "还没有草稿。",
    "plugin.zhihu-content-pipeline.review.startWriting": "开始写作",
    "plugin.zhihu-content-pipeline.review.startWritingAria": "开始写作：{title}",
    "plugin.zhihu-content-pipeline.review.close": "关闭",
    "plugin.zhihu-content-pipeline.review.loading": "加载中…",
    "plugin.zhihu-content-pipeline.command.opened": "已打开知乎选题审阅面板。",
    "plugin.zhihu-content-pipeline.command.noModal": "当前环境不支持弹窗面板。",
  },
} as const
