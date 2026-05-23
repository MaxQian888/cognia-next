---
title: Extending Platform Connectors with Plugins
description: How to write a cognia-next plugin that contributes a new messaging-platform adapter.
---

# Extending Platform Connectors with Plugins

cognia-next ships five built-in platform adapters (Telegram, Discord, Slack, Lark, OneBot). The
**Plugin Connector Bridge** (`lib/plugin/bridge/connectors-bridge.ts`) lets any installed plugin
contribute additional adapters—like Mastodon, Bluesky, Matrix, or any internal messaging system—
without touching the cognia-next source.

## How it works

1. The plugin declares `"connectors"` in `capabilities` and a `connectors[]` array in its manifest.
2. On plugin enable, `registerPluginAdapters()` calls the factory function from the plugin's
   exported module and hands the resulting `PlatformAdapter` to the `ConnectorBus`.
3. The adapter then participates in the full pipeline: inbound dedup → policy evaluation →
   mode routing → outbound FIFO queue → circuit breaker → audit log.

## Walkthrough — hypothetical Mastodon adapter

### 1. Declare the capability in `manifest.json`

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

### 2. Export the factory function

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

### 3. Register / unregister via the bridge

The bridge is called automatically by the plugin lifecycle when the user enables or disables
the plugin. You do not need to call it manually — the `PluginManager` handles this.

For debugging you can call the bridge directly:

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

## Accessing credentials

Use the Tauri keyring shims to store and retrieve secrets:

```ts
import { connectorsKeyringGet, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"

// Write — e.g., on first-time setup in your config dialog
await connectorsKeyringSet(adapterId, "accessToken", token)

// Read — inside your factory or start()
const token = await connectorsKeyringGet(adapterId, "accessToken")
```

Credentials are stored encrypted in the OS keyring (macOS Keychain, Windows Credential Manager,
libsecret on Linux). They are never logged or included in backups.

## Transport patterns

| Pattern      | When to use                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `longpoll`   | REST-based platforms with a "get updates" endpoint (Telegram, Mastodon). |
| `webhook`    | Platform pushes to a public URL via axum.                                |
| `reverse-ws` | Device connects to cognia-next (OneBot / NapCat pattern).                |
| `gateway`    | Maintain a long-lived WS to the platform (Discord).                      |

For `webhook` and `reverse-ws` you need to register an axum route in the Rust connector module.
See `src-tauri/src/connectors/` for examples.

## Coverage requirement

Plugin-contributed adapters are subject to the same ≥90% test coverage rule as built-in code
(see `CLAUDE.md`). Ship tests alongside your plugin using the same `foo.test.ts` co-location
convention.

## Reference

- `types/plugin/plugin.ts` — `PluginConnectorDef`, `PluginCapability`
- `lib/plugin/bridge/connectors-bridge.ts` — `registerPluginAdapters`, `unregisterPluginAdapters`
- `types/connectors/adapter.ts` — `PlatformAdapter` interface
- `lib/connectors/bus.ts` — `ConnectorBus` (singleton)
- ADR-0009 (`docs/content/docs/adr/0009-platform-connectors.md`) — full architecture decision
