/**
 * E2B Sandbox plugin — contributions over one shared sandbox pool:
 *
 *   1. An E2B MCP server preset (`@e2b/mcp-server` over stdio) in the MCP
 *      gallery — code execution in ephemeral Firecracker microVMs, safe for
 *      untrusted model-generated code. Declared in plugin.json only; the
 *      manager registers it, so `activate` does not.
 *   2. The `"e2b"` workspace backend (`ctx.workspace.registerBackend`) —
 *      clones a repository into a remote E2B sandbox for Marketplace
 *      integrations running with `worktreeMode: "e2b"`.
 *   3. The microVM exec adapter (`ctx.sandbox.registerMicrovmAdapter`) —
 *      routes `sandbox_*` tool calls from `sandboxTier: "microvm"` sessions
 *      into the *existing* E2B workspace sandbox rather than provisioning a
 *      second one per session.
 *
 * (2) and (3) are INTENTIONALLY DORMANT: provisioning needs the Node-only
 * `e2b` SDK, which this webview build does not bundle, so they are only
 * registered when `isProvisioningAvailable()` (see `provisioning.ts`) says a
 * sandbox can actually be created. Registering them regardless made the host
 * advertise a microVM tier that could only fail.
 *
 * Plus a Context Workbench panel (imperative — builtin plugins have no
 * fetchable entry path, so the manifest's `contextPanels` field can't resolve
 * a renderer) showing connection state and live workspaces, and a `/sandbox`
 * command that reports the same status into the chat.
 */

import type { PluginCommandResult, PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { E2BConnectionState } from "./connection"
import { PANEL_ACTIVITY, PANEL_ID } from "./ids"
import { buildMicrovmExec } from "./microvm-exec"
import { clearE2BPanelRuntime, notifyE2BPanelRuntime, setE2BPanelRuntime } from "./panel-runtime"
import { isProvisioningAvailable } from "./provisioning"
import { E2BSandboxPool } from "./sandbox-pool"
import { SandboxesPanel } from "./sandboxes-panel"
import { E2BWorkspaceBackend } from "./workspace-backend"

// plugin.json is the manifest source of truth — including the MCP preset and
// the `i18n.locales` bundle the manager merges before `activate()` runs.
export const manifest = definePluginManifest(manifestJson)

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildStatusMessage(
  ctx: PluginContext,
  connection: E2BConnectionState,
  pool: E2BSandboxPool
): string {
  const t = (key: string, vars?: Record<string, string | number>) => ctx.i18n.t(key, vars)
  const status = connection.status
  const endpoint = status.kind === "cloud" ? t("panel.status.cloud") : status.endpoint
  const lines = [
    t("command.sandbox.title"),
    "",
    `- ${t("command.sandbox.endpoint", { endpoint })}`,
    `- ${t(`command.sandbox.key.${status.apiKey}`)}`,
    `- ${t("command.sandbox.live", { count: pool.liveSandboxCount() })}`,
  ]
  if (!isProvisioningAvailable()) lines.push(`- ${t("command.sandbox.sdk")}`)
  lines.push("", t("command.sandbox.hint"))
  return lines.join("\n")
}

/**
 * Build one plugin instance. The default export is the instance the host
 * loads; a fresh instance has its own pool and registrations, which is also
 * what lets the tests start from a clean slate without a test-only seam.
 */
export function createE2BSandboxPlugin(): PluginDefinition {
  /**
   * Everything `activate` wired, in registration order. A single teardown
   * list because a re-activation (hot reload or disable→enable) must unwind
   * *all* of it, including a partial activation that threw mid-way.
   */
  const disposers: Array<() => void> = []

  /**
   * The pool deliberately outlives a single activation: its entries are
   * workspaces whose handles callers still hold. A fresh pool on
   * re-activation would orphan live sandboxes — unreachable by `remove`,
   * invisible to the panel — so registrations re-wire onto the same one.
   */
  const pool = new E2BSandboxPool()

  function teardown(): void {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Teardown is best-effort; a throwing disposer must not strand the rest.
      }
    }
  }

  return definePlugin({
    manifest,
    activate: (ctx) => {
      // A re-activation must not double-subscribe or leave the previous
      // generation's registrations live.
      teardown()
      clearE2BPanelRuntime()

      const connection = new E2BConnectionState(notifyE2BPanelRuntime)

      try {
        void connection.refresh(ctx)
        disposers.push(ctx.configuration.onChange(() => void connection.refresh(ctx)))
        disposers.push(ctx.secrets.onDidChange(() => void connection.refresh(ctx)))

        if (isProvisioningAvailable()) {
          // ADR-0026 §2 §D: `ctx.workspace.registerBackend(...)` is the only
          // registration path. The registry namespaces the id as
          // `cognia-e2b-sandbox:e2b`; the host dispatches by kind
          // (`resolveWorkspaceBackendByKind("e2b")`).
          const backend = new E2BWorkspaceBackend({
            connection: () => connection.sandboxConnection,
            pool,
          })
          const backendHandle = ctx.workspace.registerBackend({
            id: "e2b",
            label: ctx.i18n.t("backend.label"),
            description: ctx.i18n.t("backend.description"),
            backend,
          })
          disposers.push(backendHandle.unregister)

          // ADR-0028 — any session with `sandboxTier: "microvm"` routes
          // `sandbox_*` tool calls through the pooled E2B workspace sandbox
          // instead of the OS sandbox.
          disposers.push(ctx.sandbox.registerMicrovmAdapter(buildMicrovmExec({ pool })))
        }

        // Imperative registration, not `manifest.contextPanels`: builtin
        // plugins have no fetchable entry path for the manifest field to load
        // a renderer through (sre-agent precedent). Registration throws when
        // `extension:ui` / `session:read` weren't granted — degrade the panel
        // rather than failing activation, but never silently.
        try {
          disposers.push(
            ctx.contextPanels.register({
              id: PANEL_ID,
              activity: PANEL_ACTIVITY,
              label: ctx.i18n.t("panel.title"),
              // Bare key — the host resolves `plugin.<id>.<labelKey>` itself.
              labelKey: "panel.title",
              resourceKinds: ["session"],
              icon: "Box",
              order: 10,
              preferredMode: "narrow",
              retention: "stateful",
              renderer: SandboxesPanel,
            })
          )
          const syncBadge = () => ctx.contextPanels.setBadge(PANEL_ID, pool.liveSandboxCount())
          disposers.push(pool.subscribe(syncBadge))
          syncBadge()
        } catch (error) {
          ctx.logger.error(`e2b-sandbox: context panel not registered — ${describeError(error)}`)
        }

        setE2BPanelRuntime({
          pool,
          ui: ctx.ui,
          provisioningAvailable: isProvisioningAvailable(),
          getConnectionStatus: () => connection.status,
        })

        ctx.logger.info("e2b-sandbox plugin activated")
        return {
          // The command is declared in plugin.json; the manager owns
          // namespacing, palette registration, and teardown. The report goes
          // into the chat as markdown — more useful than a transient toast.
          onCommand: (command: string): boolean | PluginCommandResult => {
            if (command !== "sandbox") return false
            ctx.contextPanels.reveal(PANEL_ID)
            return { handled: true, message: buildStatusMessage(ctx, connection, pool) }
          },
        }
      } catch (error) {
        // A partially-activated plugin must not leak registrations — unwind so
        // a retry starts clean. The pool is NOT reset: it may pre-date this
        // activation and still hold live workspaces.
        teardown()
        clearE2BPanelRuntime()
        throw error
      }
    },
    deactivate: () => {
      teardown()
      clearE2BPanelRuntime()
      // Deliberately NOT clearing or disposing the pool: its entries are
      // workspaces the backend handed to callers — teammates may be working
      // inside them right now — and killing them on a plugin toggle would
      // destroy in-flight runs. They stay tracked so a re-activation can see
      // and reap them via `remove`.
    },
  })
}

export default createE2BSandboxPlugin()
