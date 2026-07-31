/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const recordStatusMock = jest.fn()
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordStatus: (...a: unknown[]) => recordStatusMock(...a),
}))

// Keep the modal import light — its real deps (stores/db) aren't needed here.
jest.mock("./ui/record-skill-modal", () => ({ RecordSkillModal: () => null }))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import plugin from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx(modal?: { openModal: jest.Mock }) {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const showToast = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-skill-recorder",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    modal: modal as never,
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
  }
  return { ctx: ctx as PluginContext, tools, showToast }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
  isTauriMock.mockReset().mockReturnValue(true)
  recordStatusMock.mockReset()
})

describe("skill-recorder (built-in)", () => {
  it("declares its command instead of registering it, and registers the status tool", async () => {
    const { ctx, tools } = makeCtx()
    const hooks = await plugin.activate?.(ctx)
    expect(registerMock).not.toHaveBeenCalled()
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (plugin.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["record-skill"])
    expect(Object.keys(tools)).toContain("record_skill_status")
  })

  it("declines commands that aren't its own", async () => {
    const openModal = jest.fn()
    const { ctx } = makeCtx({ openModal })
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("someone-else", [])).toBe(false)
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the modal on desktop", async () => {
    const openModal = jest.fn()
    const { ctx } = makeCtx({ openModal })
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("record-skill", [])).toBe(true)
    expect(openModal).toHaveBeenCalledTimes(1)
  })

  it("refuses outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const openModal = jest.fn()
    const { ctx, showToast } = makeCtx({ openModal })
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("record-skill", [])).toBe(true)
    expect(openModal).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/desktop-only/i), "error")
  })

  it("reports the UI is unavailable when no modal surface exists", async () => {
    const { ctx, showToast } = makeCtx() // no modal
    const hooks = await plugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("record-skill", [])).toBe(true)
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i), "error")
  })

  it("record_skill_status returns an error when the native call throws", async () => {
    recordStatusMock.mockRejectedValue(new Error("ipc down"))
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({ ok: false, error: "ipc down" })
  })

  it("record_skill_status returns desktop-only off Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({ ok: false, error: "desktop-only" })
    expect(recordStatusMock).not.toHaveBeenCalled()
  })

  it("record_skill_status reports the native status on Tauri", async () => {
    recordStatusMock.mockResolvedValue({ recording: true, stepCount: 3 })
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(await tools.record_skill_status({})).toMatchObject({
      ok: true,
      recording: true,
      stepCount: 3,
    })
  })
})
