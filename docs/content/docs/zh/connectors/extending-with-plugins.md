---
title: 用插件扩展平台连接器
description: 如何编写一个 cognia-next 插件，使其贡献一个新的消息平台适配器。
---

# 用插件扩展平台连接器

cognia-next 内置了七个平台适配器（Telegram、Discord、Slack、Lark、OneBot、WeCom、
个人微信）。**插件连接器桥**（`lib/plugin/bridge/connectors-bridge.ts`）让
任何已安装的插件都能贡献额外的适配器 —— 例如 Mastodon、Bluesky、Matrix，或任何
内部消息系统 —— 而无需改动 cognia-next 的源码。

## 工作原理

1. 插件在 `capabilities` 中声明 `"connectors"`，并在清单中提供一个 `connectors[]` 数组。
2. 插件启用时，`registerPluginAdapters()` 会调用插件导出模块中的工厂函数，
   并将生成的 `PlatformAdapter` 交给 `ConnectorBus`。
3. 该适配器随后便参与到完整的流水线中：入站去重 → 策略评估 →
   模式路由 → 出站 FIFO 队列 → 熔断器 → 审计日志。

## 演练 —— 假想的 Mastodon 适配器

### 1. 在 `manifest.json` 中声明能力

```json
{
  "id": "com.example.mastodon-adapter",
  "name": "Mastodon Adapter",
  "version": "1.0.0",
  "description": "Connect cognia-next to a Mastodon instance.",
  "type": "frontend",
  "capabilities": ["connectors"],
  "main": "dist/index.js",
  "connectors": [
    {
      "type": "mastodon",
      "factory": "createMastodonAdapter",
      "configSchema": {
        "type": "object",
        "required": ["instanceUrl"],
        "properties": {
          "instanceUrl": {
            "type": "string",
            "title": "Instance URL",
            "description": "Your Mastodon instance (e.g. https://mastodon.social)"
          }
        }
      },
      "transportModes": ["longpoll"]
    }
  ]
}
```

### 2. 导出工厂函数

```ts
// dist/index.ts (plugin main entry)
import type { PlatformAdapter } from "@/types/connectors"
import type { PluginAdapterContext } from "@/lib/plugin/bridge/connectors-bridge"

export function createMastodonAdapter(ctx: PluginAdapterContext): PlatformAdapter {
  const { connectorDef } = ctx

  return {
    id: `mastodon_${crypto.randomUUID()}`,
    meta: {
      type: connectorDef.type,
      displayName: "Mastodon",
      version: "1.0.0",
      capabilities: ["text", "markdown"],
      transportModes: ["longpoll"],
      configSchema: connectorDef.configSchema,
    },

    async start() {
      // Begin polling /api/v1/streaming/user via SSE or long-poll
    },

    async stop() {
      // Tear down the polling connection
    },

    health() {
      return { state: "running" }
    },

    async send(request) {
      // POST /api/v1/statuses  (or reply)
      const text = request.segments
        .filter((s) => s.type === "text" || s.type === "markdown")
        .map((s) => (s.type === "text" ? s.text : s.md))
        .join("\n")

      // … call Mastodon API …
      return { ok: true, platformMessageId: "mastodon:status:12345" }
    },
  }
}
```

### 3. 通过桥进行注册 / 注销

当用户启用或禁用插件时，插件生命周期会自动调用该桥。你无需手动调用 ——
`PluginManager` 会处理这一切。

调试时你可以直接调用该桥：

```ts
import {
  registerPluginAdapters,
  unregisterPluginAdapters,
} from "@/lib/plugin/bridge/connectors-bridge"
import manifest from "./manifest.json"
import * as exports from "./dist/index"

// Enable
await registerPluginAdapters(manifest.id, manifest, exports)

// Disable / uninstall
unregisterPluginAdapters(manifest.id)
```

## 访问凭据

使用 Tauri keyring 垫片来存储和读取密钥：

```ts
import { connectorsKeyringGet, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"

// Write — e.g., on first-time setup in your config dialog
await connectorsKeyringSet(adapterId, "accessToken", token)

// Read — inside your factory or start()
const token = await connectorsKeyringGet(adapterId, "accessToken")
```

凭据以加密形式存储在操作系统的 keyring 中（macOS Keychain、Windows Credential Manager、
Linux 上的 libsecret）。它们绝不会被记入日志或包含在备份中。

## 传输模式

| 模式         | 适用场景                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| `longpoll`   | 带有“拉取更新”端点的基于 REST 的平台（Telegram、Mastodon）。              |
| `webhook`    | 平台通过 axum 推送到一个公网 URL。                                       |
| `reverse-ws` | 设备连接到 cognia-next（OneBot / NapCat 模式）。                         |
| `gateway`    | 维持一条到平台的长连接 WS（Discord）。                                   |

对于 `webhook` 和 `reverse-ws`，你需要在 Rust 连接器模块中注册一个 axum 路由。
示例参见 `src-tauri/src/connectors/`。

## 覆盖率要求

插件贡献的适配器与内置代码遵循同样的 ≥90% 测试覆盖率规则
（参见 `CLAUDE.md`）。请使用同样的 `foo.test.ts` 同目录约定，将测试与你的插件一起发布。

## 参考

- `types/plugin/plugin.ts` —— `PluginConnectorDef`、`PluginCapability`
- `lib/plugin/bridge/connectors-bridge.ts` —— `registerPluginAdapters`、`unregisterPluginAdapters`
- `types/connectors/adapter.ts` —— `PlatformAdapter` 接口
- `lib/connectors/bus.ts` —— `ConnectorBus`（单例）
- ADR-0009（`docs/content/docs/adr/0009-platform-connectors.md`）—— 完整的架构决策
