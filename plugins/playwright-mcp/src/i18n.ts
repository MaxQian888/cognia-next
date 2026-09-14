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
    "modal.title": "Set up a Playwright browser",
    "modal.subtitle":
      "Pick how the agent should drive a browser. Each option adds a Playwright MCP server you can enable and attach to an agent.",
    "modal.env.label": "Environment",
    "modal.env.check": "Check environment",
    "modal.env.checking": "Checking…",
    "modal.env.ready": "Node.js {node} · npx {npx} — ready to spawn @playwright/mcp.",
    "modal.env.missing": "Node.js or npx was not found. Install Node.js 18+ first.",
    "modal.env.unavailable": "Shell access is unavailable in this host, so the check cannot run.",
    "modal.env.error": "The check could not run — the command was denied or failed.",
    "modal.env.hint":
      "Every preset spawns `npx @playwright/mcp` — Node.js 18+ must be on the PATH the app sees.",
    "modal.setUp": "Set up in Settings",
    "modal.afterAdd":
      "A server added from a preset starts disabled — enable it, then attach it to an agent in the character editor.",
    "modal.docs": "Playwright MCP docs",
    "modal.close": "Close",

    "mode.playwright.desc":
      "A fresh, persistent browser profile. Runs headed by default — add --headless to the server args if you do not want a visible window.",
    "mode.isolated.desc":
      "A disposable in-memory profile that keeps nothing between runs, headless so no window opens. The privacy-preserving default for unattended tasks.",
    "mode.existing.desc":
      "Drives selected tabs in the Chrome or Edge you already use, reusing its profile and login state through the official Playwright extension.",
    "mode.cdp.desc":
      "Attaches to a Chrome or Edge you launched yourself with --remote-debugging-port — for dev loops and inspecting a live session.",

    "req.node": "Requires Node.js + npx",
    "req.disposable": "Nothing persists between runs",
    "req.extension": "Needs the official Playwright extension",
    "req.approval": "You approve each tab connection",
    "req.cdpPort": "You launch the browser with --remote-debugging-port",
    "mode.existing.safety": "browser_run_code_unsafe is denied by default on this preset.",

    "command.opened": "Opened the Playwright browser setup guide.",
    "command.noModal":
      "This host cannot open the setup guide. Add a Playwright preset under Settings → MCP Servers instead.",
  },
  "zh-CN": {
    "modal.title": "配置 Playwright 浏览器",
    "modal.subtitle":
      "选择让 Agent 驱动浏览器的方式。每种方式都会添加一个 Playwright MCP 服务器，启用后可挂载到 Agent。",
    "modal.env.label": "环境",
    "modal.env.check": "检查环境",
    "modal.env.checking": "检查中…",
    "modal.env.ready": "Node.js {node} · npx {npx}，可以启动 @playwright/mcp。",
    "modal.env.missing": "未找到 Node.js 或 npx，请先安装 Node.js 18+。",
    "modal.env.unavailable": "当前宿主不支持 Shell 访问，无法执行检查。",
    "modal.env.error": "检查未能执行——命令被拒绝或运行失败。",
    "modal.env.hint":
      "每个预设都会启动 `npx @playwright/mcp`——应用进程的 PATH 中需要有 Node.js 18+。",
    "modal.setUp": "前往设置配置",
    "modal.afterAdd":
      "通过预设添加的服务器默认处于停用状态——请先启用，再在角色编辑器中把它挂载到 Agent。",
    "modal.docs": "Playwright MCP 文档",
    "modal.close": "关闭",

    "mode.playwright.desc":
      "全新的持久化浏览器配置。默认以有头模式运行——如果不想看到浏览器窗口，请在服务器参数中加上 --headless。",
    "mode.isolated.desc":
      "用完即弃的内存配置，运行之间不保留任何状态，且无头运行不弹窗。适合无人值守任务的隐私默认项。",
    "mode.existing.desc":
      "通过官方 Playwright 扩展驱动你日常使用的 Chrome 或 Edge 中已选定的标签页，复用其配置与登录状态。",
    "mode.cdp.desc":
      "附加到你自己用 --remote-debugging-port 启动的 Chrome 或 Edge——适合开发调试和观察运行中的会话。",

    "req.node": "需要 Node.js 与 npx",
    "req.disposable": "运行之间不保留状态",
    "req.extension": "需要官方 Playwright 扩展",
    "req.approval": "每个标签页连接都需你批准",
    "req.cdpPort": "需要你以 --remote-debugging-port 启动浏览器",
    "mode.existing.safety": "该预设默认禁用 browser_run_code_unsafe 工具。",

    "command.opened": "已打开 Playwright 浏览器配置向导。",
    "command.noModal":
      "当前宿主无法打开配置向导，请改为在 设置 → MCP 服务器 中手动添加 Playwright 预设。",
  },
} as const
