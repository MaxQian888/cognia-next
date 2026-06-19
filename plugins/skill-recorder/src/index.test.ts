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

interface SlashCommand {
  id: string
  handler: () => { message: string }
}

function makeCtx(modal?: { openModal: jest.Mock }) {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-skill-recorder",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    modal: modal as never,
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
  return { ctx: ctx as PluginContext, tools }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
  isTauriMock.mockReset().mockReturnValue(true)
  recordStatusMock.mockReset()
})

describe("skill-recorder (built-in)", () => {
  it("registers the /record-skill command and the status tool", async () => {
    const { ctx, tools } = makeCtx()
    await plugin.activate?.(ctx)
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill-recorder.record", name: "/record-skill" })
    )
    expect(Object.keys(tools)).toContain("record_skill_status")
  })

  it("the slash command opens the modal on desktop", async () => {
    const openModal = jest.fn()
    const { ctx } = makeCtx({ openModal })
    await plugin.activate?.(ctx)
    const cmd = registerMock.mock.calls[0][0] as SlashCommand
    const result = cmd.handler()
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(result.message).toMatch(/opened/i)
  })

  it("the slash command refuses outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const openModal = jest.fn()
    const { ctx } = makeCtx({ openModal })
    await plugin.activate?.(ctx)
    const cmd = registerMock.mock.calls[0][0] as SlashCommand
    const result = cmd.handler()
    expect(openModal).not.toHaveBeenCalled()
    expect(result.message).toMatch(/desktop-only/i)
  })

  it("the slash command reports the UI is unavailable when no modal surface exists", async () => {
    const { ctx } = makeCtx() // no modal
    await plugin.activate?.(ctx)
    const cmd = registerMock.mock.calls[0][0] as SlashCommand
    expect(cmd.handler().message).toMatch(/unavailable/i)
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

  it("deactivate unregisters the plugin commands", async () => {
    const { ctx } = makeCtx()
    await plugin.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-skill-recorder")
  })
})
