/**
 * E2B Sandbox plugin — three contributions over one shared sandbox pool:
 *
 *   1. An E2B MCP server preset (`@e2b/mcp-server` over stdio) in the MCP
 *      gallery — code execution in ephemeral Firecracker microVMs, safe for
 *      untrusted model-generated code.
 *   2. The `"e2b"` workspace backend (`ctx.workspace.registerBackend`) —
 *      clones a repository into a remote E2B sandbox for Marketplace
 *      integrations running with `worktreeMode: "e2b"`.
 *   3. The microVM exec adapter (`ctx.sandbox.registerMicrovmAdapter`) —
 *      routes `sandbox_*` tool calls from `sandboxTier: "microvm"` sessions
 *      into the *existing* E2B workspace sandbox rather than provisioning a
 *      second one per session.
 *
 * Plus a Context Workbench panel (imperative — builtin plugins have no
 * fetchable entry path, so the manifest's `contextPanels` field can't resolve
 * a renderer) showing connection state and live workspaces, and a `/sandbox`
 * command that reports the same status into the chat.
 *
 * The API key lives in the OS keyring via `ctx.secrets` (`secrets:write`
 * prompts once per session); a plaintext `apiKey` still sitting in plugin
 * config — pre-migration install, or a fresh settings save — is moved into
 * the keyring on activate/config-change and the field cleared.
 *
 * Honest boundary: provisioning a sandbox requires the Node-only `e2b` SDK,
 * which is not bundled into this webview build — `workspace-backend.ts`
 * documents the dormant path. The MCP preset works regardless via `npx`.
 */

import type { PluginContext, PluginCommandResult } from "@cognia/plugin-sdk"
import { defineMcpServerPreset, definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { E2BWorkspaceBackend } from "./workspace-backend"
import type { E2BSandboxConnection } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import { E2BSandboxPool } from "./sandbox-pool"
import { SandboxesPanel } from "./sandboxes-panel"
import {
  clearE2BPanelRuntime,
  notifyE2BPanelRuntime,
  setE2BPanelRuntime,
  type E2BConnectionStatus,
} from "./panel-runtime"
import { PANEL_ACTIVITY, PANEL_ID, SECRET_API_KEY } from "./ids"
import { I18N_MESSAGES } from "./i18n"
import { translate } from "./use-plugin-t"

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

/**
 * Everything `activate` wired, in registration order. A single teardown list
 * instead of per-handle variables because a re-activation (hot reload or
 * disable→enable) must unwind *all* of it, including a partial activation
 * that threw mid-way.
 */
const disposers: Array<() => void> = []

/** The live pool — module-scoped because there's only ever one plugin instance. */
let sandboxPool: E2BSandboxPool | null = null

/**
 * What the workspace backend hands `Sandbox.create`. Rebuilt by
 * `refreshConnection` from keyring + config; never holds a plaintext key that
 * the keyring could have carried unless keyring access was denied.
 */
let sandboxConnection: E2BSandboxConnection = {}

/** Last computed panel/command status snapshot. */
let connectionStatus: E2BConnectionStatus = {
  endpoint: "",
  kind: "cloud",
  apiKey: "missing",
}

/**
 * Once a keyring write fails (consent denied, or a host without the secrets
 * API), don't re-prompt on every config change for the rest of the session.
 */
let secretsDenied = false

/** Supersession counter — a slow keyring read must not clobber a newer refresh. */
let refreshSeq = 0

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function teardown(): void {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // Teardown is best-effort; a throwing disposer must not strand the rest.
    }
  }
}

/**
 * Rebuild `sandboxConnection` + `connectionStatus` from keyring and config.
 *
 * Migration rule: a non-empty `config.apiKey` means the key is sitting in
 * plaintext plugin config (this field predates the keyring path, and the
 * settings form still writes there). Move it into `ctx.secrets` once and
 * clear the field; if the write is refused, keep using the plaintext value —
 * the user has a working setup and shouldn't lose it because we couldn't get
 * consent — and report it as `pending` instead of `keyring`.
 *
 * Serialized by `refreshSeq`: `configuration.update` itself fires `onChange`,
 * so a second refresh can start while this one is still awaiting the keyring.
 */
async function refreshConnection(ctx: PluginContext): Promise<void> {
  const seq = ++refreshSeq
  try {
    const config = ctx.configuration?.getAll?.() ?? ctx.config ?? {}
    const plaintext = readString(config.apiKey)
    // `domain` is the native SDK override (e.g. an AgentENV host); `apiUrl`
    // is the user-facing alias — domain wins when both are set.
    const domain = readString(config.domain) ?? readString(config.apiUrl)

    let keyringKey: string | undefined
    try {
      keyringKey = readString(await ctx.secrets?.get(SECRET_API_KEY))
    } catch {
      // No secrets:read on this host — fall through to the plaintext value.
      keyringKey = undefined
    }

    // `?.store` on a host without the secrets API would silently skip the
    // write and then report `keyring` — only attempt the move when the
    // API actually exists.
    if (plaintext && !secretsDenied && typeof ctx.secrets?.store === "function") {
      try {
        if (plaintext !== keyringKey) {
          await ctx.secrets.store(SECRET_API_KEY, plaintext)
          if (seq !== refreshSeq) return
        }
        await ctx.configuration?.update?.("apiKey", "")
        if (seq !== refreshSeq) return
        keyringKey = plaintext
      } catch (error) {
        secretsDenied = true
        ctx.logger.warn(
          `e2b-sandbox: could not move the API key into the OS keyring (${describeError(
            error
          )}) — leaving the settings value in place for this session`
        )
      }
    }

    const apiKey = keyringKey ?? plaintext
    sandboxConnection = {
      ...(apiKey ? { apiKey } : {}),
      ...(domain ? { domain } : {}),
    }
    connectionStatus = {
      endpoint: domain ?? "",
      kind: domain ? "custom" : "cloud",
      apiKey: keyringKey ? "keyring" : plaintext ? "pending" : "missing",
    }
    notifyE2BPanelRuntime()
  } catch (error) {
    ctx.logger.warn(`e2b-sandbox: connection refresh failed (${describeError(error)})`)
  }
}

function buildStatusMessage(ctx: PluginContext): string {
  const locale = ctx.i18n?.getCurrentLocale?.() ?? "en"
  const status = connectionStatus
  const endpoint =
    status.kind === "cloud" ? translate(locale, "panel.status.cloud") : status.endpoint
  return [
    translate(locale, "command.sandbox.title"),
    "",
    `- ${translate(locale, "command.sandbox.endpoint", { endpoint })}`,
    `- ${translate(locale, `command.sandbox.key.${status.apiKey}`)}`,
    `- ${translate(locale, "command.sandbox.live", { count: sandboxPool?.liveSandboxCount() ?? 0 })}`,
    `- ${translate(locale, "command.sandbox.sdk")}`,
    "",
    translate(locale, "command.sandbox.hint"),
  ].join("\n")
}

const definition = definePlugin({
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would win and silently drop manifest fields.
  manifest: definePluginManifest({
    ...manifestJson,
    mcpServerPresets: [E2B_PRESET],
    i18n: { locales: I18N_MESSAGES },
  }),
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("e2b-sandbox plugin activated")

    // A re-activation must not double-subscribe or leave the previous
    // generation's registrations live.
    teardown()
    clearE2BPanelRuntime()
    secretsDenied = false

    // The pool deliberately outlives a single activation: its entries are
    // workspaces whose handles callers still hold. A fresh pool on
    // re-activation would orphan live sandboxes — unreachable by `remove`,
    // invisible to the panel — so registrations re-wire onto the same one.
    const pool = sandboxPool ?? new E2BSandboxPool()
    sandboxPool = pool

    try {
      void refreshConnection(ctx)
      const offConfig = ctx.configuration?.onChange?.(() => void refreshConnection(ctx))
      if (offConfig) disposers.push(offConfig)
      const offSecrets = ctx.secrets?.onDidChange?.(() => void refreshConnection(ctx))
      if (offSecrets) disposers.push(offSecrets)

      ctx.agent?.registerMcpServerPreset?.(E2B_PRESET)

      // ADR-0026 §2 §D: `ctx.workspace.registerBackend(...)` is the only
      // registration path. Every host context carries `ctx.workspace`, so a
      // missing API is a host contract violation — fail loudly rather than
      // fall back to a shim that would register under a different id. The
      // registry namespaces the id as `cognia-e2b-sandbox:e2b`; the host
      // dispatches by kind (`resolveWorkspaceBackendByKind("e2b")`).
      if (!ctx.workspace) {
        throw new Error(
          "[e2b-sandbox] host context has no `workspace` API — cannot register the e2b workspace backend"
        )
      }
      const backend = new E2BWorkspaceBackend({
        connection: () => sandboxConnection,
        pool,
      })
      const backendHandle = ctx.workspace.registerBackend({
        id: "e2b",
        label: "E2B Firecracker",
        description:
          "Runs each turn inside an ephemeral Firecracker microVM sandbox. Untrusted-code safe.",
        backend,
      })
      disposers.push(backendHandle.unregister)

      // ADR-0028 — register the microvm exec adapter so any session with
      // `sandboxTier: "microvm"` routes `sandbox_*` tool calls through an
      // ephemeral Firecracker microVM instead of the OS sandbox.
      disposers.push(ctx.sandbox.registerMicrovmAdapter(buildMicrovmExec({ pool })))

      // Imperative registration, not `manifest.contextPanels`: builtin
      // plugins have no fetchable entry path for the manifest field to load
      // a renderer through (sre-agent precedent). Registration throws when
      // `extension:ui` / `session:read` weren't granted — degrade the panel
      // rather than failing activation, but never silently.
      try {
        const disposePanel = ctx.contextPanels?.register?.({
          id: PANEL_ID,
          activity: PANEL_ACTIVITY,
          label: "Sandboxes",
          // Bare key — the host resolves `plugin.<id>.<labelKey>` itself.
          labelKey: "panel.title",
          resourceKinds: ["session"],
          icon: "Box",
          order: 10,
          preferredMode: "narrow",
          retention: "stateful",
          renderer: SandboxesPanel,
        })
        if (disposePanel) {
          disposers.push(disposePanel)
          const syncBadge = () => ctx.contextPanels?.setBadge(PANEL_ID, pool.liveSandboxCount())
          disposers.push(pool.subscribe(syncBadge))
          syncBadge()
        }
      } catch (error) {
        ctx.logger?.error?.(`e2b-sandbox: context panel not registered — ${describeError(error)}`)
      }

      setE2BPanelRuntime({
        pool,
        ui: ctx.ui ?? null,
        getConnectionStatus: () => connectionStatus,
      })

      return {
        // The command is declared in plugin.json; the manager owns
        // namespacing, palette registration, and teardown. The report goes
        // into the chat as markdown — more useful than a transient toast.
        onCommand: (command: string): boolean | PluginCommandResult => {
          if (command !== "sandbox") return false
          ctx.contextPanels?.reveal?.(PANEL_ID)
          return { handled: true, message: buildStatusMessage(ctx) }
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
  deactivate: async () => {
    teardown()
    clearE2BPanelRuntime()
    secretsDenied = false
    // Deliberately NOT clearing or disposing the pool: its entries are
    // workspaces the backend handed to callers — teammates may be working
    // inside them right now — and killing them on a plugin toggle would
    // destroy in-flight runs. They stay tracked so a re-activation can see
    // and reap them via `remove`.
  },
})

export default definition

/** Test surface for the migration path — not part of the plugin contract. */
export const __internals = {
  refreshConnection,
  getConnectionStatus: () => connectionStatus,
  getSandboxConnection: () => sandboxConnection,
  resetState: () => {
    teardown()
    clearE2BPanelRuntime()
    sandboxPool = null
    sandboxConnection = {}
    connectionStatus = { endpoint: "", kind: "cloud", apiKey: "missing" }
    secretsDenied = false
    refreshSeq = 0
  },
}
