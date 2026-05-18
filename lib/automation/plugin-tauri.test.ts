/**
 * Unit tests for the plugin-tauri wrappers. Mocks `transport.call` and
 * asserts each wrapper marshals the command name + payload correctly.
 */

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

import { transport } from "@/lib/tauri"
import {
  pluginComputerUseBash,
  pluginComputerUseExecute,
  pluginComputerUseTextEditor,
} from "./plugin-tauri"

const mockCall = transport.call as unknown as jest.Mock

afterEach(() => {
  mockCall.mockReset()
})

describe("plugin-tauri wrappers", () => {
  it("pluginComputerUseExecute forwards action + ctx", async () => {
    mockCall.mockResolvedValueOnce({ ok: true })
    const result = await pluginComputerUseExecute(
      { action: "screenshot" },
      { surface: "computerUse", pluginId: "cognia-computer-use" }
    )
    expect(mockCall).toHaveBeenCalledWith("plugin_computer_use_execute", {
      action: { action: "screenshot" },
      ctx: { surface: "computerUse", pluginId: "cognia-computer-use" },
    })
    expect(result).toEqual({ ok: true })
  })

  it("pluginComputerUseExecute accepts no ctx", async () => {
    mockCall.mockResolvedValueOnce({ ok: true })
    await pluginComputerUseExecute({ action: "screenshot" })
    expect(mockCall).toHaveBeenCalledWith("plugin_computer_use_execute", {
      action: { action: "screenshot" },
      ctx: undefined,
    })
  })

  it("pluginComputerUseBash forwards command + restart", async () => {
    mockCall.mockResolvedValueOnce({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
      duration_ms: 12,
    })
    const result = await pluginComputerUseBash(
      { command: "echo hello", restart: false },
      { surface: "computerUse" }
    )
    expect(mockCall).toHaveBeenCalledWith("plugin_computer_use_bash", {
      action: { command: "echo hello", restart: false },
      ctx: { surface: "computerUse" },
    })
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe("hello\n")
  })

  it("pluginComputerUseTextEditor forwards view action", async () => {
    mockCall.mockResolvedValueOnce({ ok: true, content: "file content" })
    const result = await pluginComputerUseTextEditor(
      { action: "view", path: "/tmp/x.txt" },
      { surface: "computerUse" }
    )
    expect(mockCall).toHaveBeenCalledWith("plugin_computer_use_text_editor", {
      action: { action: "view", path: "/tmp/x.txt" },
      ctx: { surface: "computerUse" },
    })
    expect(result.content).toBe("file content")
  })

  it("pluginComputerUseTextEditor forwards str_replace action", async () => {
    mockCall.mockResolvedValueOnce({ ok: true })
    await pluginComputerUseTextEditor({
      action: "str_replace",
      path: "/tmp/x.txt",
      old_str: "old",
      new_str: "new",
    })
    expect(mockCall).toHaveBeenCalledWith("plugin_computer_use_text_editor", {
      action: {
        action: "str_replace",
        path: "/tmp/x.txt",
        old_str: "old",
        new_str: "new",
      },
      ctx: undefined,
    })
  })

  it("propagates errors thrown by transport.call", async () => {
    mockCall.mockRejectedValueOnce(new Error("denied"))
    await expect(
      pluginComputerUseExecute({ action: "screenshot" }, { surface: "computerUse" })
    ).rejects.toThrow("denied")
  })
})
