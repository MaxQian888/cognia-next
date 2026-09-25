import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"
import packagedManifest from "../plugin.json"

const fakeBackend = { kind: "e2b-backend" }
jest.mock("./workspace-backend", () => ({
  E2BWorkspaceBackend: jest.fn(() => fakeBackend),
}))

const fakeExec = { kind: "microvm-exec", dispose: jest.fn(async () => undefined) }
jest.mock("./microvm-exec", () => ({ buildMicrovmExec: jest.fn(() => fakeExec) }))

// The panel pulls `@cognia/plugin-ui` into the module graph; the entrypoint
// tests only need the registration to receive *a* renderer.
jest.mock("./sandboxes-panel", () => ({ SandboxesPanel: () => null }))

// The real gate is pinned `false` by `provisioning.test.ts`; mocking it here
// lets the (kept, dormant) registration path be exercised both ways.
jest.mock("./provisioning", () => ({ isProvisioningAvailable: jest.fn(() => false) }))

import { E2BWorkspaceBackend } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import { isProvisioningAvailable } from "./provisioning"
import defaultPlugin, { createE2BSandboxPlugin, manifest } from "./index"
import { clearE2BPanelRuntime, peekE2BPanelRuntime } from "./panel-runtime"
import { PANEL_ID, SECRET_API_KEY } from "./ids"

const E2BWorkspaceBackendMock = E2BWorkspaceBackend as jest.Mock
const buildMicrovmExecMock = buildMicrovmExec as jest.Mock
const isProvisioningAvailableMock = isProvisioningAvailable as jest.Mock

type Locale = keyof typeof packagedManifest.i18n.locales

function translator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) => {
    const bundle = packagedManifest.i18n.locales[locale] as Record<string, string>
    const en = packagedManifest.i18n.locales.en as Record<string, string>
    const template = bundle[key] ?? en[key] ?? key
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      vars?.[name] === undefined ? match : String(vars[name])
    )
  }
}

/** Let the fire-and-forget connection refresh started by `activate` settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeCtx(
  opts: {
    config?: Record<string, unknown>
    keyring?: Record<string, string>
    locale?: Locale
    panelThrows?: boolean
    adapterThrows?: boolean
  } = {}
) {
  const unregister = jest.fn()
  const registerBackend = jest.fn(() => ({ backendId: "cognia-e2b-sandbox:e2b", unregister }))
  const config = { ...(opts.config ?? {}) }
  const configUnsubscribe = jest.fn()
  const secretsUnsubscribe = jest.fn()
  const panelDispose = jest.fn()
  const unregisterMicrovmAdapter = jest.fn()
  const registerMicrovmAdapter = jest.fn(() => {
    if (opts.adapterThrows) throw new Error("native:process not granted")
    return unregisterMicrovmAdapter
  })
  const keyring = { ...(opts.keyring ?? {}) }
  const secrets = {
    get: jest.fn(async (key: string) => keyring[key] ?? null),
    store: jest.fn(async (key: string, value: string) => {
      keyring[key] = value
    }),
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
  const registerMcpServerPreset = jest.fn()
  const ctx = {
    pluginId: "cognia-e2b-sandbox",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config,
    configuration: {
      getAll: () => config,
      update: jest.fn(async (key: string, value: unknown) => {
        config[key] = value
      }),
      onChange: jest.fn(() => configUnsubscribe),
    },
    secrets,
    i18n: { t: jest.fn(translator(opts.locale ?? "en")) },
    agent: { registerMcpServerPreset },
    ui: { showToast: jest.fn() },
    contextPanels,
    workspace: { registerBackend },
    sandbox: { registerMicrovmAdapter },
  }
  return {
    ctx: ctx as unknown as PluginContext,
    registerBackend,
    registerMcpServerPreset,
    unregister,
    configUnsubscribe,
    secretsUnsubscribe,
    panelDispose,
    registerMicrovmAdapter,
    unregisterMicrovmAdapter,
    contextPanels,
    secrets,
    keyring,
  }
}

function fakeSandbox(id: string) {
  return { id, exec: jest.fn(), close: jest.fn(async () => undefined) }
}

beforeEach(() => {
  E2BWorkspaceBackendMock.mockClear()
  buildMicrovmExecMock.mockClear()
  fakeExec.dispose.mockClear()
  isProvisioningAvailableMock.mockReturnValue(false)
})

afterEach(() => clearE2BPanelRuntime())

describe("e2b-sandbox manifest", () => {
  it("is plugin.json, with the MCP preset and i18n bundle declared there", () => {
    expect(manifest).toEqual(packagedManifest)
    expect(defaultPlugin.manifest).toBe(manifest)
    expect(findPluginManifestParityIssues(packagedManifest as never, manifest)).toEqual([])

    const preset = packagedManifest.mcpServerPresets[0]
    expect(preset.id).toBe("e2b-sandbox")
    expect(preset.config.env).toHaveProperty("E2B_API_URL")
    const byKey = Object.fromEntries(preset.fields.map((f) => [f.key, f]))
    expect(byKey.E2B_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.E2B_API_URL).toMatchObject({ placement: "env" })
  })

  it("does not claim Computer Use isolation", () => {
    expect(packagedManifest.description).not.toMatch(/computer use/i)
  })

  it("says the MCP preset needs its own key, since the plugin key cannot reach it", () => {
    const apiKey = packagedManifest.configSchema.properties.apiKey
    expect(apiKey.secret).toBe(true)
    expect(apiKey).not.toHaveProperty("default")
    expect(apiKey.description).toMatch(/E2B_API_KEY/)
    expect(apiKey.description).toMatch(/does not read this value/)
  })

  it("keeps bare i18n keys — the manager adds the `plugin.<id>.` prefix on merge", () => {
    const en = Object.keys(packagedManifest.i18n.locales.en)
    expect(en.length).toBeGreaterThan(0)
    expect(en.every((key) => !key.startsWith("plugin."))).toBe(true)
  })
})

describe("e2b-sandbox activation", () => {
  it("leaves the MCP preset to the manifest instead of registering it a second time", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx, registerMcpServerPreset } = makeCtx()
    await plugin.activate(ctx)
    expect(registerMcpServerPreset).not.toHaveBeenCalled()
    await plugin.deactivate?.(ctx)
  })

  it("registers neither the workspace backend nor the microVM adapter while provisioning is dormant", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx, registerBackend, registerMicrovmAdapter, contextPanels } = makeCtx()
    await plugin.activate(ctx)

    // Registering them would make Settings → Sandbox offer a microVM tier that
    // can only fail (`provisioning.ts`).
    expect(registerBackend).not.toHaveBeenCalled()
    expect(registerMicrovmAdapter).not.toHaveBeenCalled()
    expect(E2BWorkspaceBackendMock).not.toHaveBeenCalled()
    // The panel still mounts and is told the tier is inactive.
    expect(contextPanels.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PANEL_ID,
        activity: "e2b-sandboxes",
        label: "Sandboxes",
        labelKey: "panel.title",
        resourceKinds: ["session"],
        retention: "stateful",
      })
    )
    expect(peekE2BPanelRuntime()?.provisioningAvailable).toBe(false)
    expect(contextPanels.setBadge).toHaveBeenLastCalledWith(PANEL_ID, 0)
    await plugin.deactivate?.(ctx)
  })

  it("registers the localized backend and the microVM adapter once provisioning is available", async () => {
    isProvisioningAvailableMock.mockReturnValue(true)
    const plugin = createE2BSandboxPlugin()
    const { ctx, registerBackend, registerMicrovmAdapter } = makeCtx({ locale: "zh-CN" })
    await plugin.activate(ctx)

    expect(registerBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "e2b",
        label: "E2B Firecracker 微虚拟机",
        description: packagedManifest.i18n.locales["zh-CN"]["backend.description"],
        backend: fakeBackend,
      })
    )
    expect(registerMicrovmAdapter).toHaveBeenCalledWith(fakeExec)
    expect(peekE2BPanelRuntime()?.provisioningAvailable).toBe(true)
    await plugin.deactivate?.(ctx)
  })

  it("feeds the backend the live connection, keyring key included", async () => {
    isProvisioningAvailableMock.mockReturnValue(true)
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx({ keyring: { [SECRET_API_KEY]: "key_abc" } })
    await plugin.activate(ctx)
    await flush()

    const options = E2BWorkspaceBackendMock.mock.calls[0][0] as {
      connection: () => { apiKey?: string }
    }
    expect(options.connection()).toEqual({ apiKey: "key_abc" })
    await plugin.deactivate?.(ctx)
  })

  it("survives a panel registration failure — the command still works, error logged", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx({ panelThrows: true })
    const hooks = await plugin.activate(ctx)
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("context panel not registered")
    )
    const result = (await hooks?.onCommand?.("sandbox", [])) as { handled: boolean }
    expect(result.handled).toBe(true)
    // The runtime is still parked — a late-mounting panel finds the pool.
    expect(peekE2BPanelRuntime()).not.toBeNull()
    await plugin.deactivate?.(ctx)
  })

  it("unwinds config/secrets subscriptions when activation fails mid-way", async () => {
    isProvisioningAvailableMock.mockReturnValue(true)
    const plugin = createE2BSandboxPlugin()
    const { ctx, configUnsubscribe, secretsUnsubscribe, unregister } = makeCtx({
      adapterThrows: true,
    })
    await expect(async () => plugin.activate(ctx)).rejects.toThrow(/native:process/)
    expect(configUnsubscribe).toHaveBeenCalled()
    expect(secretsUnsubscribe).toHaveBeenCalled()
    expect(unregister).toHaveBeenCalled()
    expect(peekE2BPanelRuntime()).toBeNull()
  })
})

describe("/sandbox", () => {
  it("answers with a localized markdown report that labels provisioning inactive", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx, contextPanels } = makeCtx()
    const hooks = await plugin.activate(ctx)
    await flush()

    const result = (await hooks?.onCommand?.("sandbox", [])) as {
      handled: boolean
      message: string
    }
    expect(result.handled).toBe(true)
    expect(result.message).toContain("E2B sandbox")
    expect(result.message).toContain("Endpoint: E2B Cloud")
    expect(result.message).toContain("API key: not set")
    expect(result.message).toContain("Live workspaces: 0")
    expect(result.message).toContain("inactive in this build")
    expect(contextPanels.reveal).toHaveBeenCalledWith(PANEL_ID)
    expect(await hooks?.onCommand?.("other", [])).toBe(false)
    await plugin.deactivate?.(ctx)
  })

  it("drops the inactive line once provisioning is available", async () => {
    isProvisioningAvailableMock.mockReturnValue(true)
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx()
    const hooks = await plugin.activate(ctx)
    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).not.toContain("inactive in this build")
    await plugin.deactivate?.(ctx)
  })

  it("localizes for zh-CN and counts live workspaces", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx({ locale: "zh-CN" })
    const hooks = await plugin.activate(ctx)
    peekE2BPanelRuntime()?.pool.addWorkspace("/tmp/cognia/a", fakeSandbox("sbx-1"), "on")

    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).toContain("E2B 沙箱")
    expect(result.message).toContain("活动工作区：1")
    await plugin.deactivate?.(ctx)
  })

  it("reports a key the activation refresh moved into the keyring", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx, keyring } = makeCtx({ config: { apiKey: "e2b_secret_123" } })
    const hooks = await plugin.activate(ctx)
    await flush()

    expect(keyring[SECRET_API_KEY]).toBe("e2b_secret_123")
    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).toContain("API key: stored in the OS keyring")
    await plugin.deactivate?.(ctx)
  })
})

describe("e2b-sandbox teardown", () => {
  it("deactivate tears every registration down and clears the panel runtime", async () => {
    isProvisioningAvailableMock.mockReturnValue(true)
    const plugin = createE2BSandboxPlugin()
    const {
      ctx,
      unregister,
      unregisterMicrovmAdapter,
      panelDispose,
      configUnsubscribe,
      secretsUnsubscribe,
    } = makeCtx()
    await plugin.activate(ctx)
    expect(peekE2BPanelRuntime()).not.toBeNull()

    await plugin.deactivate?.(ctx)

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(unregisterMicrovmAdapter).toHaveBeenCalledTimes(1)
    expect(panelDispose).toHaveBeenCalledTimes(1)
    expect(configUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secretsUnsubscribe).toHaveBeenCalledTimes(1)
    expect(peekE2BPanelRuntime()).toBeNull()
  })

  it("does not close live workspaces on deactivate", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx()
    await plugin.activate(ctx)
    const sandbox = fakeSandbox("sbx-1")
    peekE2BPanelRuntime()?.pool.addWorkspace("/tmp/cognia/a", sandbox, "on")

    await plugin.deactivate?.(ctx)

    // Toggling the plugin off must not destroy in-flight runs; those
    // workspaces are reaped by `remove(handle)`.
    expect(sandbox.close).not.toHaveBeenCalled()
    expect(fakeExec.dispose).not.toHaveBeenCalled()
  })

  it("keeps the same pool across a deactivate/activate cycle so live workspaces stay reachable", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx } = makeCtx()
    await plugin.activate(ctx)
    const firstPool = peekE2BPanelRuntime()?.pool
    firstPool?.addWorkspace("/tmp/cognia/a", fakeSandbox("sbx-1"), "on")

    await plugin.deactivate?.(ctx)
    await plugin.activate(ctx)

    // A fresh pool here would orphan the live workspace: nothing could see it
    // in the panel or reap it via `remove` — the remote microVM would leak.
    expect(peekE2BPanelRuntime()?.pool).toBe(firstPool)
    expect(firstPool?.snapshot().map((row) => row.workspacePath)).toEqual(["/tmp/cognia/a"])
    const hooks = await plugin.activate(ctx) // idempotent re-activation
    const result = (await hooks?.onCommand?.("sandbox", [])) as { message: string }
    expect(result.message).toContain("Live workspaces: 1")
    await plugin.deactivate?.(ctx)
  })

  it("pushes the live workspace count onto the rail badge as the pool changes", async () => {
    const plugin = createE2BSandboxPlugin()
    const { ctx, contextPanels } = makeCtx()
    await plugin.activate(ctx)
    peekE2BPanelRuntime()?.pool.addWorkspace("/tmp/cognia/a", fakeSandbox("sbx-1"), "on")

    expect(contextPanels.setBadge).toHaveBeenLastCalledWith(PANEL_ID, 1)
    await plugin.deactivate?.(ctx)
  })
})
