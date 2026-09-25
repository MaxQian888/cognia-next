import type { PluginContext, PluginToolRegistration } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import plugin, { manifest } from "./index"

const recordStatusMock = jest.fn()
const openRecorderMock = jest.fn()
const statusSnapshotMock = jest.fn()

let availability = { available: false, pluginId: null as string | null }

function translator(locale: "en" | "zh-CN") {
  return (key: string, params?: Record<string, string | number | boolean>) => {
    const bundle = manifestJson.i18n.locales[locale] as Record<string, string>
    return (bundle[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] === undefined ? match : String(params[name])
    )
  }
}

function makeCtx(locale: "en" | "zh-CN" = "en") {
  const tools = new Map<string, PluginToolRegistration>()
  const disposers: Array<() => void> = []
  const showToast = jest.fn()
  const ctx = {
    pluginId: "cognia-skill-recorder",
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ui: { showToast },
    i18n: { t: jest.fn(translator(locale)) },
    lifecycle: {
      onDispose: jest.fn((dispose: () => void) => {
        disposers.push(dispose)
      }),
    },
    agent: {
      registerTool: (tool: PluginToolRegistration) => {
        tools.set(tool.name, tool)
        return () => undefined
      },
    },
    recorder: {
      publishAvailability: () => {
        availability = { available: true, pluginId: "cognia-skill-recorder" }
        return () => {
          availability = { available: false, pluginId: null }
        }
      },
      status: (...args: unknown[]) => recordStatusMock(...args),
      open: (...args: unknown[]) => openRecorderMock(...args),
      statusSnapshot: () => statusSnapshotMock(),
    },
  } as unknown as PluginContext
  const status = () => tools.get("record_skill_status")!.execute({}, { config: {} })
  return { ctx, tools, showToast, disposers, status }
}

type Hooks = {
  onCommand: (command: string, args: string[]) => boolean | { handled: boolean; message?: string }
}

beforeEach(() => {
  recordStatusMock.mockReset()
  openRecorderMock.mockReset()
  statusSnapshotMock.mockReset().mockReturnValue({
    recording: false,
    phase: "idle",
    stepCount: 0,
  })
  availability = { available: false, pluginId: null }
})

describe("skill-recorder manifest", () => {
  it("adopts plugin.json itself as the manifest, command and strings included", () => {
    expect(manifest).toEqual(manifestJson)
    expect(plugin.manifest).toBe(manifest)
    expect(manifestJson.commands.map((c) => c.id)).toEqual(["record-skill"])
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual(
      Object.keys(manifestJson.i18n.locales.en).sort()
    )
  })

  it("is desktop-only by manifest, so activate needs no platform check", () => {
    expect(manifestJson.runtimeCompatibility.browser.availability).toBe("blocked")
    expect(manifestJson.runtimeCompatibility.mobile.availability).toBe("blocked")
  })
})

describe("record-skill command", () => {
  it("declares its command instead of registering it, and registers the status tool", async () => {
    const { ctx, tools } = makeCtx()
    const hooks = (await plugin.activate(ctx)) as unknown as Hooks
    expect(typeof hooks.onCommand).toBe("function")
    expect([...tools.keys()]).toEqual(["record_skill_status"])
    expect(tools.get("record_skill_status")!.pluginId).toBeUndefined()
  })

  it("declines commands that aren't its own", async () => {
    const { ctx } = makeCtx()
    const hooks = (await plugin.activate(ctx)) as unknown as Hooks
    expect(hooks.onCommand("someone-else", [])).toBe(false)
    expect(openRecorderMock).not.toHaveBeenCalled()
  })

  it("opens the global recorder and answers in the user's language", async () => {
    const { ctx } = makeCtx("zh-CN")
    const hooks = (await plugin.activate(ctx)) as unknown as Hooks
    expect(hooks.onCommand("record-skill", [])).toEqual({
      handled: true,
      message: manifestJson.i18n.locales["zh-CN"]["command.opened"],
    })
    expect(openRecorderMock).toHaveBeenCalledWith("plugin-command")
  })

  it("reports a refused open with a localized toast instead of throwing", async () => {
    openRecorderMock.mockImplementation(() => {
      throw new Error("policy denied")
    })
    const { ctx, showToast } = makeCtx()
    const hooks = (await plugin.activate(ctx)) as unknown as Hooks
    const result = hooks.onCommand("record-skill", [])
    expect(result).toEqual({
      handled: true,
      message: "Could not open the skill recorder: policy denied",
    })
    expect(showToast).toHaveBeenCalledWith(
      "Could not open the skill recorder: policy denied",
      "error"
    )
  })
})

describe("availability ownership", () => {
  it("publishes availability on activate", async () => {
    expect(availability.available).toBe(false)
    const { ctx } = makeCtx()
    await plugin.activate(ctx)
    expect(availability).toEqual({ available: true, pluginId: "cognia-skill-recorder" })
  })

  it("withdraws it through the plugin lifecycle, so every entry point disappears at once", async () => {
    const { ctx, disposers } = makeCtx()
    await plugin.activate(ctx)
    expect(ctx.lifecycle.onDispose).toHaveBeenCalledWith(
      expect.any(Function),
      "skill-recorder:availability"
    )
    for (const dispose of disposers) dispose()
    expect(availability).toEqual({ available: false, pluginId: null })
    expect(plugin.deactivate).toBeUndefined()
  })
})

describe("record_skill_status", () => {
  it("prefers the store while a flow is in progress", async () => {
    // Native capture has stopped but the user is still reviewing. Reporting
    // "not recording" here would be true of the hook and misleading about the
    // flow, so the store wins whenever it holds a session.
    statusSnapshotMock.mockReturnValue({ recording: false, phase: "review", stepCount: 7 })
    const { ctx, status } = makeCtx()
    await plugin.activate(ctx)
    await expect(status()).resolves.toEqual({
      ok: true,
      recording: false,
      phase: "review",
      stepCount: 7,
    })
    expect(recordStatusMock).not.toHaveBeenCalled()
  })

  it("falls back to the native status when the store is idle", async () => {
    recordStatusMock.mockResolvedValue({ recording: true, phase: "recording", stepCount: 3 })
    const { ctx, status } = makeCtx()
    await plugin.activate(ctx)
    await expect(status()).resolves.toEqual({
      ok: true,
      recording: true,
      phase: "recording",
      stepCount: 3,
    })
  })

  it("reports an idle native status without a phase as idle", async () => {
    recordStatusMock.mockResolvedValue({ recording: false, stepCount: 0 })
    const { ctx, status } = makeCtx()
    await plugin.activate(ctx)
    await expect(status()).resolves.toMatchObject({ ok: true, phase: "idle" })
  })

  it("returns an error when the native call throws", async () => {
    recordStatusMock.mockRejectedValue(new Error("ipc down"))
    const { ctx, status } = makeCtx()
    await plugin.activate(ctx)
    await expect(status()).resolves.toEqual({ ok: false, error: "ipc down" })
  })
})
