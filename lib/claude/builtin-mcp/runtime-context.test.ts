import { invoke } from "@tauri-apps/api/core"

jest.mock("@tauri-apps/api/core")
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { __resetForTests, getBuiltinMcpRuntimeContext } from "./runtime-context"

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockedIsTauri = isTauri as jest.Mock

beforeEach(() => {
  __resetForTests()
  mockedInvoke.mockReset()
  mockedIsTauri.mockReset()
})

describe("getBuiltinMcpRuntimeContext", () => {
  it("returns null outside Tauri without invoking", async () => {
    mockedIsTauri.mockReturnValue(false)
    const ctx = await getBuiltinMcpRuntimeContext()
    expect(ctx).toBeNull()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("translates snake_case payload to camelCase", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValueOnce({
      sidecar_dir: "C:\\app\\sidecar",
      socket_path: "\\\\.\\pipe\\cognia-next-a2ui-bridge",
    })
    const ctx = await getBuiltinMcpRuntimeContext()
    expect(ctx).toEqual({
      sidecarDir: "C:\\app\\sidecar",
      socketPath: "\\\\.\\pipe\\cognia-next-a2ui-bridge",
    })
    expect(mockedInvoke).toHaveBeenCalledWith("a2ui_bridge_runtime_paths")
  })

  it("caches the result across calls (no second invoke)", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValueOnce({
      sidecar_dir: "/sidecar",
      socket_path: "/sock",
    })
    const a = await getBuiltinMcpRuntimeContext()
    const b = await getBuiltinMcpRuntimeContext()
    expect(a).toBe(b)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it("__resetForTests clears the cache so the next call re-invokes", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke
      .mockResolvedValueOnce({ sidecar_dir: "/a", socket_path: "/sa" })
      .mockResolvedValueOnce({ sidecar_dir: "/b", socket_path: "/sb" })
    const first = await getBuiltinMcpRuntimeContext()
    expect(first?.sidecarDir).toBe("/a")
    __resetForTests()
    const second = await getBuiltinMcpRuntimeContext()
    expect(second?.sidecarDir).toBe("/b")
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })

  it("re-invokes after a transient failure instead of poisoning the cache", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke
      .mockRejectedValueOnce(new Error("not yet booted"))
      .mockResolvedValueOnce({ sidecar_dir: "/sidecar", socket_path: "/sock" })

    await expect(getBuiltinMcpRuntimeContext()).rejects.toThrow("not yet booted")
    const ctx = await getBuiltinMcpRuntimeContext()
    expect(ctx).toEqual({ sidecarDir: "/sidecar", socketPath: "/sock" })
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })
})
