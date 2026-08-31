/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"

const isTauriMock = jest.fn().mockReturnValue(true)

const recordStatusMock = jest.fn()
const openRecorderMock = jest.fn()
const statusSnapshotMock = jest.fn().mockReturnValue({
  recording: false,
  phase: "idle",
  stepCount: 0,
})
import plugin from "./index"

let availability = { available: false, pluginId: null as string | null }

function makeCtx() {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const showToast = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-skill-recorder",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    ui: { showToast } as never,
    agent: {
      registerTool: ({
        name,
        execute,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
      }) => {
        tools[name] = execute
      },
    } as never,
    capabilities: { tauri: isTauriMock() } as never,
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
    } as never,
  }
  return { ctx: ctx as PluginContext, tools, showToast }
}

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  recordStatusMock.mockReset()
  openRecorderMock.mockReset()
  statusSnapshotMock.mockReset().mockReturnValue({
    recording: false,
    phase: "idle",
    stepCount: 0,
  })
  availability = { available: false, pluginId: null }
})

describe("skill-recorder (built-in)", () => {
  it("declares its command instead of registering it, and registers the status tool", async () => {
    const { ctx, tools } = makeCtx()
    const hooks = await plugin.activate?.(ctx)
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (plugin.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["record-skill"])
    expect(Object.keys(tools)).toContain("record_skill_status")
  })

  it("declines commands that aren't its own", async () => {
    const { ctx } = makeCtx()
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("someone-else", [])).toBe(false)
    expect(openRecorderMock).not.toHaveBeenCalled()
  })

  it("opens the global recorder on desktop", async () => {
    const { ctx } = makeCtx()
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("record-skill", [])).toBe(true)
    expect(openRecorderMock).toHaveBeenCalledWith("plugin-command")
  })

  it("refuses outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { ctx, showToast } = makeCtx()
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("record-skill", [])).toBe(true)
    expect(openRecorderMock).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/desktop-only/i), "error")
  })
})

describe("availability ownership", () => {
  it("publishes availability on activate", async () => {
    expect(availability.available).toBe(false)
    const { ctx } = makeCtx()
    await plugin.activate?.(ctx)
    expect(availability).toEqual({
      available: true,
      pluginId: "cognia-skill-recorder",
    })
  })

  it("withdraws it on deactivate, so every entry point disappears at once", async () => {
    const { ctx } = makeCtx()
    await plugin.activate?.(ctx)
    await plugin.deactivate?.(ctx)
    expect(availability).toEqual({ available: false, pluginId: null })
  })
})

describe("record_skill_status", () => {
  it("returns desktop-only off Tauri without touching the native call", async () => {
    isTauriMock.mockReturnValue(false)
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({ ok: false, error: "desktop-only" })
    expect(recordStatusMock).not.toHaveBeenCalled()
  })

  it("prefers the store while a flow is in progress", async () => {
    // Native capture has stopped but the user is still reviewing. Reporting
    // "not recording" here would be true of the hook and misleading about the
    // flow, so the store wins whenever it holds a session.
    statusSnapshotMock.mockReturnValue({ recording: false, phase: "review", stepCount: 7 })
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({
      ok: true,
      recording: false,
      phase: "review",
      stepCount: 7,
    })
    expect(recordStatusMock).not.toHaveBeenCalled()
  })

  it("falls back to the native status when the store is idle", async () => {
    recordStatusMock.mockResolvedValue({ recording: true, phase: "recording", stepCount: 3 })
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({
      ok: true,
      recording: true,
      phase: "recording",
      stepCount: 3,
    })
  })

  it("returns an error when the native call throws", async () => {
    recordStatusMock.mockRejectedValue(new Error("ipc down"))
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({ ok: false, error: "ipc down" })
  })
})
