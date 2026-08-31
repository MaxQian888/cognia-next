/**
 * E2B Sandbox plugin — contributes an E2B MCP server preset to
 * cognia-next's MCP gallery.
 *
 * E2B runs each code-execution in its own Firecracker microVM (the same
 * virtualization tech behind AWS Lambda), which is the safest way to
 * have a model write+run untrusted code without touching the host. Useful
 * for Computer Use isolation, code interpretation, and data-analysis
 * workflows.
 *
 * Wrapper tools for the ai-sdk runtime path (e2b.run_python /
 * e2b.run_node) are deferred — the MCP preset already covers both
 * runtimes via the M2 bridge once it lands.
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import { defineMcpServerPreset, definePlugin } from "@cognia/plugin-sdk"
import type { PluginManifest } from "@cognia/plugin-sdk/manifest"
import manifestJson from "../plugin.json"
import { E2BWorkspaceBackend } from "./workspace-backend"
import type { E2BSandboxConnection } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import { E2BSandboxPool } from "./sandbox-pool"

const E2B_PRESET = defineMcpServerPreset({
  id: "e2b-sandbox",
  name: "E2B Sandbox",
  description:
    "Run code in ephemeral Firecracker microVM sandboxes — Python, Node, shell, file ops. Untrusted-code safe.",
  icon: "📦",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@e2b/mcp-server"],
    env: { E2B_API_KEY: "", E2B_API_URL: "" },
  },
  fields: [
    {
      key: "E2B_API_KEY",
      label: "E2B / AgentENV API key",
      placement: "env",
      secret: true,
      description: "Required for E2B Cloud; optional for local AgentENV if auth is disabled.",
    },
    {
      key: "E2B_API_URL",
      label: "AgentENV / E2B API URL",
      placement: "env",
      placeholder: "http://127.0.0.1:8000",
      description: "Set this to your AgentENV server URL. Leave empty for E2B Cloud.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/e2b-dev/mcp-server",
  tags: ["sandbox", "code", "execution"],
})

// Disposer returned by `ctx.workspace.registerBackend(...)`, stashed
// across activate/deactivate so the registration is torn down explicitly on
// disable. Module-scoped because there's only ever one e2b plugin instance.
let workspaceRegistrationDispose: (() => void) | undefined
let microvmRegistrationDispose: (() => void) | undefined
let configChangeDispose: (() => void) | undefined
let sandboxConnection: E2BSandboxConnection = {}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function connectionFromConfig(config: Record<string, unknown> | undefined): E2BSandboxConnection {
  const apiKey = readString(config?.apiKey)
  const domain = readString(config?.domain) ?? readString(config?.apiUrl)
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(domain ? { domain } : {}),
  }
}

function updateSandboxConnection(config: Record<string, unknown> | undefined): void {
  sandboxConnection = connectionFromConfig(config)
}

const manifest = {
  ...manifestJson,
  type: "frontend",
  author: { name: manifestJson.author },
  capabilities: ["mcp-server-preset", "commands", "configuration"],
  permissions: ["native:process"],
  configSchema: {
    ...manifestJson.configSchema,
    type: "object",
    properties: {
      apiKey: {
        ...manifestJson.configSchema.properties.apiKey,
        type: "string",
      },
      apiUrl: {
        ...manifestJson.configSchema.properties.apiUrl,
        type: "string",
      },
    },
  },
  activationEvents: ["startup", "onCommand:sandbox"],
  runtimeCompatibility: {
    browser: {
      availability: "blocked",
      reason: manifestJson.runtimeCompatibility.browser.reason,
    },
    tauri: {
      availability: "supported",
      entrypoint: manifestJson.runtimeCompatibility.tauri.entrypoint,
    },
    mobile: {
      availability: "blocked",
      reason: manifestJson.runtimeCompatibility.mobile.reason,
    },
  },
  commands: [
    {
      id: "sandbox",
      name: "/sandbox",
      description: manifestJson.commands[0].description,
      icon: "Box",
    },
  ],
  mcpServerPresets: [E2B_PRESET],
} satisfies PluginManifest

const definition = definePlugin({
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would win and silently drop manifest fields.
  // Literal discriminants above preserve compile-time contribution checking
  // despite TypeScript widening values imported from JSON.
  manifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("e2b-sandbox plugin activated")
    configChangeDispose?.()
    updateSandboxConnection(ctx.configuration?.getAll?.() ?? ctx.config)
    configChangeDispose = ctx.configuration?.onChange?.((config) => {
      updateSandboxConnection(config)
    })

    ctx.agent?.registerMcpServerPreset?.(E2B_PRESET)

    // Register the cloud-sandbox workspace backend for Marketplace
    // integrations that select `worktreeMode: "e2b"`. The backend lazy-loads
    // `@e2b/sdk`; if the SDK isn't installed it surfaces a helpful install
    // hint at the first clone attempt instead of failing at activation time.
    //
    // ADR-0026 §2 §D: `ctx.workspace.registerBackend(...)` is the only
    // registration path. Every host context carries `ctx.workspace`
    // (`lib/plugin/core/context.ts` sets it unconditionally), so a missing
    // API is a host contract violation — fail loudly rather than fall back to
    // a shim that would register under a different id than the host resolves.
    // The registry namespaces the id as `cognia-e2b-sandbox:e2b`; the host
    // dispatches by kind (`resolveWorkspaceBackendByKind("e2b")`).
    if (!ctx.workspace) {
      throw new Error(
        "[e2b-sandbox] host context has no `workspace` API — cannot register the e2b workspace backend"
      )
    }
    const sandboxPool = new E2BSandboxPool()
    const backend = new E2BWorkspaceBackend({
      connection: () => sandboxConnection,
      pool: sandboxPool,
    })
    const handle = ctx.workspace.registerBackend({
      id: "e2b",
      label: "E2B Firecracker",
      description:
        "Runs each turn inside an ephemeral Firecracker microVM sandbox. Untrusted-code safe.",
      backend,
    })
    workspaceRegistrationDispose = handle.unregister

    // ADR-0028 / T4 — register the microvm exec adapter so any session
    // with `sandboxTier: "microvm"` routes `sandbox_*` tool calls through
    // an ephemeral Firecracker microVM instead of the OS sandbox. When
    // `@e2b/sdk` isn't installed the factory throws a clean install hint
    // at first call — strict-mode compliant (no silent fallback).
    microvmRegistrationDispose = ctx.sandbox.registerMicrovmAdapter(
      buildMicrovmExec({ pool: sandboxPool })
    )

    // The slash command is declared in plugin.json so the manager owns
    // namespacing, command-palette registration, idle refresh, and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "sandbox") return false
        ctx.ui?.showToast?.(
          "Configure workspace/T4 credentials in Settings → Plugins → E2B Sandbox. Separately configure and attach the E2B preset in Settings → MCP Servers.",
          "info"
        )
        return true
      },
    }
  },
  deactivate: async () => {
    if (configChangeDispose) {
      configChangeDispose()
      configChangeDispose = undefined
    }
    if (workspaceRegistrationDispose) {
      workspaceRegistrationDispose()
      workspaceRegistrationDispose = undefined
    }
    // Unregister the adapter, but do NOT dispose the pool. The pool's entries
    // are workspaces `E2BWorkspaceBackend.clone` handed to callers — Agent Team
    // teammates are working inside them right now — and closing those here
    // destroys in-flight runs the moment the plugin is toggled off. They are
    // owned by the handles that were issued and are reaped by `remove(handle)`.
    microvmRegistrationDispose?.()
    microvmRegistrationDispose = undefined
  },
})

export default definition
