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

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineMcpServerPreset } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
// `setE2BBackend` kept as a fallback for hosts that don't expose
// `ctx.workspace` yet (older bootstrap paths / unit-test contexts). When
// the new API is present, we register through it for ADR-0026 §2 §D
// lifecycle + multi-backend semantics; otherwise we fall back to the
// legacy singleton path. The legacy path is now itself a shim over the
// same registry (see `lib/github/workspace.ts`).
import { setE2BBackend } from "@/lib/github/workspace"
import { setMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { E2BWorkspaceBackend } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"

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
    env: { E2B_API_KEY: "" },
  },
  fields: [
    {
      key: "E2B_API_KEY",
      label: "E2B API key",
      placement: "env",
      secret: true,
      description: "Get one at e2b.dev.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/e2b-dev/mcp-server",
  tags: ["sandbox", "code", "execution"],
})

// Disposer returned by `ctx.workspace.registerBackend(...)`, stashed
// across activate/deactivate so the v2 registration is torn down
// explicitly rather than relying on the legacy `setE2BBackend(null)`
// shim. Module-scoped because there's only ever one e2b plugin instance.
let workspaceRegistrationDispose: (() => void) | undefined

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    mcpServerPresets: [E2B_PRESET],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("e2b-sandbox plugin activated")

    ctx.agent?.registerMcpServerPreset?.(E2B_PRESET)

    // Register the cloud-sandbox workspace backend so GitHub Delivery's
    // Issue → PR loop can opt in via `worktreeMode: "e2b"`. The backend
    // lazy-loads `@e2b/sdk`; if the SDK isn't installed it surfaces a
    // helpful install hint at the first clone attempt instead of failing
    // here at activation time.
    //
    // Prefer ADR-0026 §2 §D `ctx.workspace.registerBackend(...)` when
    // available so the registration carries the plugin id + auto-cleanup
    // on disable. Fall back to the legacy `setE2BBackend(...)` shim when
    // running under an older host that doesn't expose `ctx.workspace`
    // (e.g. a sidecar harness or pre-v0.5 host). Both paths end up in the
    // same `workspace-backend-registry` either way — see
    // `lib/github/workspace.ts:setE2BBackend`.
    const backend = new E2BWorkspaceBackend()
    if (ctx.workspace) {
      const handle = ctx.workspace.registerBackend({
        id: "e2b",
        label: "E2B Firecracker",
        description:
          "Runs each turn inside an ephemeral Firecracker microVM sandbox. Untrusted-code safe.",
        backend,
      })
      workspaceRegistrationDispose = handle.unregister
    } else {
      setE2BBackend(backend)
      workspaceRegistrationDispose = () => setE2BBackend(null)
    }

    // ADR-0028 / T4 — register the microvm exec adapter so any session
    // with `sandboxTier: "microvm"` routes `sandbox_*` tool calls through
    // an ephemeral Firecracker microVM instead of the OS sandbox. When
    // `@e2b/sdk` isn't installed the factory throws a clean install hint
    // at first call — strict-mode compliant (no silent fallback).
    setMicrovmExec(buildMicrovmExec())
    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "sandbox") return false
        ctx.ui?.showToast?.(
          "Open Settings → MCP Servers, click E2B Sandbox in the gallery, paste your E2B API key, then attach it to the current character.",
          "info"
        )
        return true
      },
    }
  },
  deactivate: async () => {
    if (workspaceRegistrationDispose) {
      workspaceRegistrationDispose()
      workspaceRegistrationDispose = undefined
    }
    setMicrovmExec(null)
  },
}

export default definition
