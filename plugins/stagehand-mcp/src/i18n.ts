/**
 * Declarative i18n bundle (ADR-0026 §5 §D). The plugin manager auto-wires
 * `manifest.i18n.locales` on enable and tears it down on disable. Keys here
 * are UNPREFIXED — the manager stamps `plugin.<pluginId>.` onto each key when
 * it merges the bundle into the host registry, so a prefix here would
 * double-prefix into a namespace nothing can resolve. Plugin bundles do NOT
 * touch `i18n/messages/{en,zh-CN}.json`, so the host `lint:i18n` baseline is
 * unaffected.
 *
 * Preset card titles intentionally stay English: they must match the names
 * the user lands on in Settings → MCP Servers → preset gallery, where every
 * preset name (static or plugin) is English-only. Everything around the
 * title is localized.
 */

export const I18N_MESSAGES = {
  en: {
    "modal.title": "Set up a Stagehand browser",
    "modal.subtitle":
      "Pick how the agent should drive a browser. Each option adds a Stagehand MCP server you can enable and attach to an agent.",
    "modal.recommended": "Recommended",
    "modal.env.label": "Environment — self-hosted only",
    "modal.env.check": "Check environment",
    "modal.env.checking": "Checking…",
    "modal.env.ready": "Node.js {node} · npx {npx} — ready to spawn @browserbasehq/mcp.",
    "modal.env.missing": "Node.js or npx was not found. Install Node.js 18+ first.",
    "modal.env.unavailable": "Shell access is unavailable in this host, so the check cannot run.",
    "modal.env.error": "The check could not run — the command was denied or failed.",
    "modal.env.hint":
      "Only the self-hosted preset spawns `npx @browserbasehq/mcp` — Node.js 18+ must be on the PATH the app sees. The hosted option needs nothing local.",
    "modal.setUp": "Set up in Settings",
    "modal.afterAdd":
      "A server added from a preset starts disabled — enable it, then attach it to an agent in the character editor.",
    "modal.docs": "Browserbase MCP docs",
    "modal.close": "Close",

    "mode.hosted.desc":
      "Browserbase runs the MCP endpoint and the Chromium session for you — no local Node.js, and the default Gemini model cost is covered. The only credential is your API key, sent as a request header and stored in the credential vault.",
    "mode.selfHosted.desc":
      "Spawns @browserbasehq/mcp locally over stdio. Full flag control (--modelName, --proxies, --keepAlive, …) at the cost of a Node.js toolchain and three credentials.",

    "req.noNode": "No local Node.js",
    "req.bbKeyOnly": "Browserbase API key only",
    "req.modelCovered": "Default model cost covered",
    "req.node": "Requires Node.js + npx",
    "req.threeKeys": "API key + project ID + model key",
    "req.flags": "Full CLI flag control",

    "command.opened": "Opened the Stagehand browser setup guide.",
    "command.noModal":
      "This host cannot open the setup guide. Add a Stagehand preset under Settings → MCP Servers instead.",
  },
  "zh-CN": {
    "modal.title": "配置 Stagehand 浏览器",
    "modal.subtitle":
      "选择让 Agent 驱动浏览器的方式。每种方式都会添加一个 Stagehand MCP 服务器，启用后可挂载到 Agent。",
    "modal.recommended": "推荐",
    "modal.env.label": "环境 —— 仅自托管需要",
    "modal.env.check": "检查环境",
    "modal.env.checking": "检查中…",
    "modal.env.ready": "Node.js {node} · npx {npx}，可以启动 @browserbasehq/mcp。",
    "modal.env.missing": "未找到 Node.js 或 npx，请先安装 Node.js 18+。",
    "modal.env.unavailable": "当前宿主不支持 Shell 访问，无法执行检查。",
    "modal.env.error": "检查未能执行——命令被拒绝或运行失败。",
    "modal.env.hint":
      "只有自托管预设会启动 `npx @browserbasehq/mcp`——应用进程的 PATH 中需要有 Node.js 18+。托管方式不需要任何本地环境。",
    "modal.setUp": "前往设置配置",
    "modal.afterAdd":
      "通过预设添加的服务器默认处于停用状态——请先启用，再在角色编辑器中把它挂载到 Agent。",
    "modal.docs": "Browserbase MCP 文档",
    "modal.close": "关闭",

    "mode.hosted.desc":
      "由 Browserbase 运行 MCP 端点和 Chromium 会话——无需本地 Node.js，默认 Gemini 模型的费用由 Browserbase 承担。只需提供 API key（以请求头发送并存入凭证库）。",
    "mode.selfHosted.desc":
      "在本地通过 stdio 启动 @browserbasehq/mcp。可以用全部 CLI 参数（--modelName、--proxies、--keepAlive 等），代价是需要 Node.js 工具链和三份凭证。",

    "req.noNode": "无需本地 Node.js",
    "req.bbKeyOnly": "仅需 Browserbase API key",
    "req.modelCovered": "默认模型费用已由平台承担",
    "req.node": "需要 Node.js 与 npx",
    "req.threeKeys": "API key + 项目 ID + 模型 key",
    "req.flags": "支持全部 CLI 参数",

    "command.opened": "已打开 Stagehand 浏览器配置向导。",
    "command.noModal":
      "当前宿主无法打开配置向导，请改为在 设置 → MCP 服务器 中手动添加 Stagehand 预设。",
  },
} as const
