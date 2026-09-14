// Declarative i18n bundle. Keys are BARE (`panel.title`): the plugin manager
// prefixes them `plugin.<id>.` when merging `manifest.i18n.locales` into the
// host bundle (lib/plugin/core/manager.ts), the workbench resolves a plugin
// panel's `labelKey` as `plugin.<id>.<labelKey>`, and both `ctx.i18n.t` and
// `use-plugin-t` add the prefix themselves. Shipping prefixed keys here would
// land double-prefixed in the merged bundle — that accident is exactly what
// sre-agent's bundle carries; this one does not.

export const I18N_MESSAGES = {
  en: {
    // Context Workbench panel
    "panel.title": "Sandboxes",
    "panel.subtitle": "E2B workspaces and microVM execution",
    "panel.status.endpoint": "Endpoint",
    "panel.status.apiKey": "API key",
    "panel.status.cloud": "E2B Cloud",
    "panel.status.keyring": "API key stored in the OS keyring",
    "panel.status.keyPending": "API key pending keyring migration",
    "panel.status.keyMissing": "No API key — required for E2B Cloud",
    "panel.status.sdkDormant":
      "Provisioning unavailable in this build — the `e2b` SDK is not bundled",
    "panel.unavailable": "The E2B Sandbox plugin is not active.",
    "panel.empty.title": "No live E2B workspaces",
    "panel.empty.body":
      "A workspace appears when an integration clones a repository with the E2B backend. The microVM tier then runs commands inside it — it does not provision a second sandbox per session.",
    "panel.row.session": "Session {id}",
    "panel.row.owners": "{count} runtime owner(s)",
    "panel.row.networkOn": "network on",
    "panel.row.networkOff": "network off",
    "panel.row.released": "handle released",
    "panel.row.closing": "closing…",
    "panel.row.release": "Release",
    "panel.row.releaseConfirm": "Confirm release",
    "panel.row.releaseAria": "Release workspace {path}",
    "panel.row.releaseFailed": "Failed to release {path}",
    "panel.hint":
      "Configure the connection in Settings → Plugins → E2B Sandbox; attach the E2B preset in Settings → MCP Servers.",
    // /sandbox command report (markdown, rendered into the chat)
    "command.sandbox.title": "## E2B sandbox",
    "command.sandbox.endpoint": "Endpoint: {endpoint}",
    "command.sandbox.key.keyring": "API key: stored in the OS keyring",
    "command.sandbox.key.pending": "API key: set (keyring migration pending)",
    "command.sandbox.key.missing": "API key: not set",
    "command.sandbox.live": "Live workspaces: {count}",
    "command.sandbox.sdk":
      "Workspace provisioning: unavailable in this build — the `e2b` SDK is not bundled",
    "command.sandbox.hint":
      "Configure the connection in **Settings → Plugins → E2B Sandbox**; attach the E2B preset in **Settings → MCP Servers**.",
  },
  "zh-CN": {
    "panel.title": "沙箱",
    "panel.subtitle": "E2B 工作区与 microVM 执行",
    "panel.status.endpoint": "端点",
    "panel.status.apiKey": "API 密钥",
    "panel.status.cloud": "E2B Cloud",
    "panel.status.keyring": "API 密钥已存入系统钥匙串",
    "panel.status.keyPending": "API 密钥待迁移至钥匙串",
    "panel.status.keyMissing": "未配置 API 密钥 —— E2B Cloud 必需",
    "panel.status.sdkDormant": "此构建暂不支持沙箱创建 —— 未内置 `e2b` SDK",
    "panel.unavailable": "E2B Sandbox 插件未启用。",
    "panel.empty.title": "暂无活动 E2B 工作区",
    "panel.empty.body":
      "当集成使用 E2B 后端克隆仓库时会创建工作区；microVM 档位随后在已有工作区内执行命令 —— 不会为每个会话单独创建第二个沙箱。",
    "panel.row.session": "会话 {id}",
    "panel.row.owners": "{count} 个运行时持有方",
    "panel.row.networkOn": "网络开启",
    "panel.row.networkOff": "网络关闭",
    "panel.row.released": "句柄已释放",
    "panel.row.closing": "正在关闭…",
    "panel.row.release": "释放",
    "panel.row.releaseConfirm": "确认释放",
    "panel.row.releaseAria": "释放工作区 {path}",
    "panel.row.releaseFailed": "释放 {path} 失败",
    "panel.hint": "在 设置 → 插件 → E2B Sandbox 配置连接；在 设置 → MCP Servers 挂载 E2B 预设。",
    "command.sandbox.title": "## E2B 沙箱",
    "command.sandbox.endpoint": "端点：{endpoint}",
    "command.sandbox.key.keyring": "API 密钥：已存入系统钥匙串",
    "command.sandbox.key.pending": "API 密钥：已配置（待迁移至钥匙串）",
    "command.sandbox.key.missing": "API 密钥：未配置",
    "command.sandbox.live": "活动工作区：{count} 个",
    "command.sandbox.sdk": "工作区创建：此构建不可用 —— 未内置 `e2b` SDK",
    "command.sandbox.hint":
      "在 **设置 → 插件 → E2B Sandbox** 中配置连接；在 **设置 → MCP Servers** 中挂载预设。",
  },
}
