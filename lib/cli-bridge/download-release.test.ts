/**
 * @jest-environment jsdom
 */

import { downloadCogniaCli } from "./download-release"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockListen = listen as jest.MockedFunction<typeof listen>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
})

describe("downloadCogniaCli", () => {
  it("invokes download_cognia_cli and returns the receipt", async () => {
    const unlisten = jest.fn()
    mockListen.mockResolvedValueOnce(unlisten)
    mockInvoke.mockResolvedValueOnce({
      version: "latest",
      installDir: "/data/cognia/cli/latest",
      binaryPath: "/data/cognia/cli/latest/cognia",
      signatureVerified: false,
    })
    const onProgress = jest.fn()
    const result = await downloadCogniaCli({ onProgress })
    expect(mockInvoke).toHaveBeenCalledWith("download_cognia_cli", {
      releaseTag: null,
      repo: null,
      targetDir: null,
    })
    expect(result.installDir).toBe("/data/cognia/cli/latest")
    expect(result.signatureVerified).toBe(false)
    // listener torn down after the invoke resolves
    expect(unlisten).toHaveBeenCalled()
  })

  it("forwards release tag / repo / target dir overrides", async () => {
    mockListen.mockResolvedValueOnce(jest.fn())
    mockInvoke.mockResolvedValueOnce({
      version: "v0.2.0",
      installDir: "/custom",
      binaryPath: "/custom/cognia",
      signatureVerified: true,
    })
    await downloadCogniaCli({
      releaseTag: "v0.2.0",
      repo: "fork/cognia",
      targetDir: "/custom",
    })
    expect(mockInvoke).toHaveBeenCalledWith("download_cognia_cli", {
      releaseTag: "v0.2.0",
      repo: "fork/cognia",
      targetDir: "/custom",
    })
  })

  it("relays progress events to the callback", async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementationOnce(async (_event, cb) => {
      handler = cb as (e: { payload: unknown }) => void
      return jest.fn()
    })
    mockInvoke.mockImplementationOnce(async () => {
      // Fire a progress event mid-download.
      handler?.({ payload: { stage: "downloading", progress: 0.5, message: "…" } })
      return {
        version: "latest",
        installDir: "/x",
        binaryPath: "/x/cognia",
        signatureVerified: false,
      }
    })
    const onProgress = jest.fn()
    await downloadCogniaCli({ onProgress })
    expect(onProgress).toHaveBeenCalledWith({
      stage: "downloading",
      progress: 0.5,
      message: "…",
    })
  })

  it("rejects on web without invoking", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(downloadCogniaCli()).rejects.toThrow(/requires the desktop app/i)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("tears down the listener even when the download throws", async () => {
    const unlisten = jest.fn()
    mockListen.mockResolvedValueOnce(unlisten)
    mockInvoke.mockRejectedValueOnce(new Error("checksum mismatch"))
    await expect(downloadCogniaCli({ onProgress: jest.fn() })).rejects.toThrow(/checksum mismatch/)
    expect(unlisten).toHaveBeenCalled()
  })
})
