import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"
import packagedManifest from "../plugin.json"

const fakeBackend = { kind: "e2b-backend" }
jest.mock("./workspace-backend", () => ({
  E2BWorkspaceBackend: jest.fn(() => fakeBackend),
}))

const fakeExec = { kind: "microvm-exec", dispose: jest.fn(async () => undefined) }
jest.mock("./microvm-exec", () => ({ buildMicrovmExec: jest.fn(() => fakeExec) }))

// The panel pulls `@cognia/plugin-ui` + next-intl into the module graph; the
// entrypoint tests only need the registration to receive *a* renderer.
jest.mock("./sandboxes-panel", () => ({ SandboxesPanel: () => null }))

import { E2BWorkspaceBackend } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import e2bSandbox, { __internals } from "./index"
import { peekE2BPanelRuntime } from "./panel-runtime"
import { PANEL_ID, SECRET_API_KEY } from "./ids"

const E2BWorkspaceBackendMock = E2BWorkspaceBackend as jest.Mock
const buildMicrovmExecMock = buildMicrovmExec as jest.Mock

function makeCtx(
  opts: {
    workspace?: boolean
    config?: Record<string, unknown>
    keyring?: Record<string, string>
    locale?: string
    panelThrows?: boolean
  } = {}
) {
  const presets: Array<{ id: string }> = []
  const unregister = jest.fn()
  const registerBackend = jest.fn(() => ({ unregister }))
  const showToast = jest.fn()
  const config = { ...(opts.config ?? {}) }
  const configUnsubscribe = jest.fn()
  const secretsUnsubscribe = jest.fn()
  const panelDispose = jest.fn()
  const unregisterMicrovmAdapter = jest.fn()
  const registerMicrovmAdapter = jest.fn(() => unregisterMicrovmAdapter)
  const update = jest.fn(async (key: string, value: unknown) => {
    config[key] = value
  })
  const keyring = { ...(opts.keyring ?? {}) }
  const secrets = {
    get: jest.fn(async (key: string) => keyring[key] ?? null),
    store: jest.fn(async (key: string, value: string) => {
      keyring[key] = value
    }),
    has: jest.fn(async (key: string) => key in keyring),
    delete: jest.fn(async (key: string) => {
      delete keyring[key]
    }),
    keys: jest.fn(async () => Object.keys(keyring)),
    onDidChange: jest.fn(() => secretsUnsubscribe),
  }
  const contextPanels = {
    register: jest.fn(() => {
      if (opts.panelThrows) throw new Error("extension:ui not granted")
      return panelDispose
    }),
    reveal: jest.fn(),
    setBadge: jest.fn(),
  }
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-e2b-sandbox",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    config,
    configuration: {
      getAll: () => config,
      update,
      onChange: (_listener: (next: Record<string, unknown>) => void) => {
        return configUnsubscribe
      },
    } as never,
    secrets: secrets as never,
    i18n: { getCurrentLocale: () => opts.locale ?? "en" } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
    ui: { showToast } as never,
    contextPanels: contextPanels as never,
    workspace: opts.workspace ? ({ registerBackend } as never) : undefined,
    sandbox: { registerMicrovmAdapter } as never,
  }
  return {
    ctx: ctx as PluginContext,
    presets,
    registerBackend,
    unregister,
    showToast,
    configUnsubscribe,
    secretsUnsubscribe,
    panelDispose,
    registerMicrovmAdapter,
    unregisterMicrovmAdapter,
    contextPanels,
    secrets,
    update,
    config,
    keyring,
  }
}

beforeEach(() => {
  E2BWorkspaceBackendMock.mockClear()
  buildMicrovmExecMock.mockClear()
  fakeExec.dispose.mockClear()
  __internals.resetState()
})

afterEach(() => __internals.resetState())

describe("e2b-sandbox (built-in)", () => {
  it("declares the full manifest and keeps module parity with plugin.json", () => {
    const manifest = e2bSandbox.manifest as unknown as {
      capabilities: string[]
      permissions: string[]
      activationEvents: string[]
      commands: Array<{ id: string; name: string }>
      configSchema?: { properties?: Record<string, { default?: unknown; secret?: boolean }> }
      defaultConfig?: Record<string, unknown>
      i18n?: { locales?: Record<string, Record<string, string>> }
      mcpServerPresets: Array<{
        id: string
        config: { env?: Record<string, string> }
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "mcp-server-preset",
        "commands",
        "configuration",
        "workspace-backend",
        "context-panel",
      ])
    )
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "native:process",
        "secrets:read",
        "secrets:write",
        "extension:ui",
        "session:read",
      ])
    )
    expect(manifest.activationEvents).toContain("onCommand:sandbox")
    expect(manifest.commands).toContainEqual(expect.objectContaining({ id: "sandbox" }))
    // The secret field must not ship a default — the keyring, not plugin
    // config, is its durable home.
    expect(manifest.configSchema?.properties?.apiKey?.default).toBeUndefined()
    expect(manifest.configSchema?.properties?.apiKey?.secret).toBe(true)
    expect(manifest.configSchema?.properties).toHaveProperty("apiUrl")
    expect(manifest.configSchema?.properties).toHaveProperty("domain")
    expect(manifest.defaultConfig?.apiKey).toBeUndefined()
    // Bare keys — the manager adds the `plugin.<id>.` prefix on merge.
    const en = manifest.i18n?.locales?.en ?? {}
    expect(Object.keys(en).length).toBeGreaterThan(0)
    expect(Object.keys(en).every((key) => !key.startsWith("plugin."))).toBe(true)
    const preset = manifest.mcpServerPresets[0]
    expect(preset.id).toBe("e2b-sandbox")
    expect(preset.config.env).toHaveProperty("E2B_API_URL")
    const byKey = Object.fromEntries(preset.fields.map((f) => [f.key, f]))
    expect(byKey.E2B_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.E2B_API_URL).toMatchObject({ placement: "env" })
    // Same contract check sre-agent runs: module manifest must not drift from
    // the packaged one.
    expect(findPluginManifestParityIssues(packagedManifest as never, e2bSandbox.manifest)).toEqual(
      []
    )
  })

  it("activate registers the preset, backend, microvm adapter, and panel", async () => {
    const { ctx, presets, registerBackend, registerMicrovmAdapter, contextPanels } = makeCtx({
      workspace: true,
    })
    await e2bSandbox.activate?.(ctx)
    expect(presets).toEqual([expect.objectContaining({ id: "e2b-sandbox" })])
    expect(registerBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e2b", backend: fakeBackend })
    )
    expect(registerMicrovmAdapter).toHaveBeenCalledWith(fakeExec)
    expect(contextPanels.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PANEL_ID,
        activity: "e2b-sandboxes",
        labelKey: "panel.title",
        resourceKinds: ["session"],
        retention: "stateful",
      })
    )
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith(PANEL_ID, 0)
    await e2bSandbox.deactivate?.(ctx)
  })

  it("/sandbox answers with a localized markdown status report and reveals the panel", async () => {
    const { ctx, contextPanels } = makeCtx({ workspace: true })
    const hooks = await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    const result = (await hooks?.onCommand?.("sandbox", [])) as {
      handled: boolean
      message: string
    }
    expect(result.handled).toBe(true)
    expect(result.message).toContain("E2B sandbox")
    expect(result.message).toContain("Endpoint:")
    expect(result.message).toContain("API key: not set")
    expect(result.message).toContain("Live workspaces: 0")
    expect(contextPanels.reveal).toHaveBeenCalledWith(PANEL_ID)
    expect(await hooks?.onCommand?.("other", [])).toBe(false)
    await e2bSandbox.deactivate?.(ctx)
  })

  it("/sandbox localizes for zh-CN and counts live workspaces", async () => {
    const { ctx } = makeCtx({ workspace: true, locale: "zh-CN" })
    const hooks = await e2bSandbox.activate?.(ctx)
    const pool = peekE2BPanelRuntime()?.pool
    pool?.addWorkspace(
      "/tmp/cognia/a",
      {
        id: "sbx-1",
        exec: jest.fn(),
        close: jest.fn(async () => undefined),
      },
      "on"
    )

    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).toContain("E2B 沙箱")
    expect(result.message).toContain("活动工作区：1")
    await e2bSandbox.deactivate?.(ctx)
  })

  it("migrates a plaintext apiKey into the keyring and clears the field", async () => {
    const { ctx, secrets, update, config, keyring } = makeCtx({
      workspace: true,
      config: { apiKey: "e2b_secret_123" },
    })
    await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    expect(secrets.store).toHaveBeenCalledWith(SECRET_API_KEY, "e2b_secret_123")
    expect(update).toHaveBeenCalledWith("apiKey", "")
    expect(keyring[SECRET_API_KEY]).toBe("e2b_secret_123")
    expect(config.apiKey).toBe("")
    expect(__internals.getSandboxConnection().apiKey).toBe("e2b_secret_123")
    expect(__internals.getConnectionStatus().apiKey).toBe("keyring")
    await e2bSandbox.deactivate?.(ctx)
  })

  it("prefers the keyring value and does not re-store it", async () => {
    const { ctx, secrets } = makeCtx({
      workspace: true,
      keyring: { [SECRET_API_KEY]: "key_abc" },
    })
    await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    expect(secrets.store).not.toHaveBeenCalled()
    expect(__internals.getSandboxConnection().apiKey).toBe("key_abc")
    expect(__internals.getConnectionStatus().apiKey).toBe("keyring")
    await e2bSandbox.deactivate?.(ctx)
  })

  it("keeps a plaintext key working (reported pending) when keyring write is refused, and does not nag", async () => {
    const { ctx, secrets, update } = makeCtx({
      workspace: true,
      config: { apiKey: "e2b_secret_123" },
    })
    secrets.store.mockRejectedValueOnce(new Error("consent denied"))
    await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    expect(update).not.toHaveBeenCalled()
    expect(__internals.getSandboxConnection().apiKey).toBe("e2b_secret_123")
    expect(__internals.getConnectionStatus().apiKey).toBe("pending")

    // A second refresh in the same session must not re-prompt for consent.
    await __internals.refreshConnection(ctx)
    expect(secrets.store).toHaveBeenCalledTimes(1)
    await e2bSandbox.deactivate?.(ctx)
  })

  it("keeps working when the keyring itself is unavailable (host without secrets:read)", async () => {
    const { ctx, secrets } = makeCtx({
      workspace: true,
      config: { apiKey: "e2b_secret_123" },
    })
    secrets.get.mockRejectedValue(new Error("secrets:read not granted"))
    secrets.store.mockRejectedValue(new Error("secrets:write consent denied"))
    await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    // Plaintext still flows through — the user has a working setup — and the
    // status honestly reports the key never reached the keyring.
    expect(__internals.getSandboxConnection().apiKey).toBe("e2b_secret_123")
    expect(__internals.getConnectionStatus().apiKey).toBe("pending")
    await e2bSandbox.deactivate?.(ctx)
  })

  it("reads no apiKey at all as missing, and lets `domain` beat `apiUrl`", async () => {
    const { ctx } = makeCtx({
      workspace: true,
      config: { apiUrl: "http://127.0.0.1:8000", domain: "e2b.internal.example.com" },
    })
    await e2bSandbox.activate?.(ctx)
    await __internals.refreshConnection(ctx)

    const connection = __internals.getSandboxConnection()
    expect(connection.apiKey).toBeUndefined()
    expect(connection.domain).toBe("e2b.internal.example.com")
    expect(__internals.getConnectionStatus()).toMatchObject({
      kind: "custom",
      endpoint: "e2b.internal.example.com",
      apiKey: "missing",
    })
    await e2bSandbox.deactivate?.(ctx)
  })

  it("survives a panel registration failure — tools still work, error logged", async () => {
    const { ctx } = makeCtx({ workspace: true, panelThrows: true })
    const hooks = await e2bSandbox.activate?.(ctx)
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("context panel not registered")
    )
    const result = (await hooks?.onCommand?.("sandbox", [])) as { handled: boolean }
    expect(result.handled).toBe(true)
    // The runtime is still parked — a late-mounting panel finds the pool.
    expect(peekE2BPanelRuntime()).not.toBeNull()
    await e2bSandbox.deactivate?.(ctx)
  })

  it("unwinds config/secrets subscriptions when activation fails mid-way", async () => {
    const { ctx, configUnsubscribe, secretsUnsubscribe } = makeCtx({ workspace: false })
    await expect(e2bSandbox.activate?.(ctx)).rejects.toThrow(/no `workspace` API/)
    expect(configUnsubscribe).toHaveBeenCalled()
    expect(secretsUnsubscribe).toHaveBeenCalled()
    expect(E2BWorkspaceBackendMock).not.toHaveBeenCalled()
    expect(peekE2BPanelRuntime()).toBeNull()
  })

  it("deactivate tears every registration down and clears the panel runtime", async () => {
    const {
      ctx,
      unregister,
      unregisterMicrovmAdapter,
      panelDispose,
      configUnsubscribe,
      secretsUnsubscribe,
    } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(peekE2BPanelRuntime()).not.toBeNull()

    await e2bSandbox.deactivate?.(ctx)

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(unregisterMicrovmAdapter).toHaveBeenCalledTimes(1)
    expect(panelDispose).toHaveBeenCalledTimes(1)
    expect(configUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secretsUnsubscribe).toHaveBeenCalledTimes(1)
    expect(peekE2BPanelRuntime()).toBeNull()
  })

  it("does not close live workspaces on deactivate", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    const pool = peekE2BPanelRuntime()?.pool
    const close = jest.fn(async () => undefined)
    pool?.addWorkspace("/tmp/cognia/a", { id: "sbx-1", exec: jest.fn(), close }, "on")

    await e2bSandbox.deactivate?.(ctx)

    // `dispose()` closes every entry in the shared pool — including the
    // workspaces `E2BWorkspaceBackend.clone` handed to teammates who are still
    // working inside them. Toggling the plugin off must not destroy in-flight
    // runs; those workspaces are reaped by `remove(handle)`.
    expect(close).not.toHaveBeenCalled()
    expect(fakeExec.dispose).not.toHaveBeenCalled()
  })

  it("keeps the same pool across a deactivate/activate cycle so live workspaces stay reachable", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    const firstPool = peekE2BPanelRuntime()?.pool
    firstPool?.addWorkspace(
      "/tmp/cognia/a",
      {
        id: "sbx-1",
        exec: jest.fn(),
        close: jest.fn(async () => undefined),
      },
      "on"
    )

    await e2bSandbox.deactivate?.(ctx)
    await e2bSandbox.activate?.(ctx)

    // A fresh pool here would orphan the live workspace: nothing could see it
    // in the panel or reap it via `remove` — the remote microVM would leak.
    expect(peekE2BPanelRuntime()?.pool).toBe(firstPool)
    expect(firstPool?.snapshot().map((row) => row.workspacePath)).toEqual(["/tmp/cognia/a"])
    const hooks = await e2bSandbox.activate?.(ctx) // idempotent re-activation
    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).toContain("Live workspaces: 1")
    await e2bSandbox.deactivate?.(ctx)
  })

  it("pushes the live workspace count onto the rail badge as the pool changes", async () => {
    const { ctx, contextPanels } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    const pool = peekE2BPanelRuntime()?.pool
    pool?.addWorkspace(
      "/tmp/cognia/a",
      {
        id: "sbx-1",
        exec: jest.fn(),
        close: jest.fn(async () => undefined),
      },
      "on"
    )

    expect(contextPanels.setBadge).toHaveBeenLastCalledWith(PANEL_ID, 1)
    await e2bSandbox.deactivate?.(ctx)
  })
})
