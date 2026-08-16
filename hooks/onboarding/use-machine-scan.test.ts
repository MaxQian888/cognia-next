/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

const probeVendors = jest.fn()
jest.mock("@/lib/agent-migration/probe", () => ({ probeVendors: () => probeVendors() }))

jest.mock("@/lib/ai/agent/external/presets", () => ({
  EXTERNAL_AGENT_PRESETS: { "claude-code": { name: "Claude Code" } },
}))

let ocrSettings: unknown = { defaultProviderId: "auto" }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { settings: { ocrSettings: unknown } }) => unknown) =>
    selector({ settings: { ocrSettings } }),
}))

import { useMachineScan } from "./use-machine-scan"

beforeEach(() => {
  probeVendors.mockReset().mockResolvedValue([])
  ocrSettings = { defaultProviderId: "auto" }
})

describe("useMachineScan", () => {
  it("does not probe off the desktop and settles immediately", async () => {
    const { result } = renderHook(() => useMachineScan("web"))
    expect(probeVendors).not.toHaveBeenCalled()
    expect(result.current.phase).toBe("empty")
    // The web reader runs anywhere, so the universal card stays available.
    expect(result.current.result.capabilities).toContain("web")
  })

  it("reports a found runtime as authenticated when its config is on disk", async () => {
    probeVendors.mockResolvedValue([
      { vendor: "claude-code", installed: true, configPath: "/home/.claude.json" },
    ])
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(result.current.phase).toBe("found"))
    expect(result.current.result.runtimes).toEqual([
      { id: "claude-code", label: "Claude Code", authenticated: true },
    ])
  })

  it("treats a config-less install as present but not signed in", async () => {
    probeVendors.mockResolvedValue([{ vendor: "claude-code", installed: true }])
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(result.current.phase).toBe("found"))
    expect(result.current.result.runtimes[0]?.authenticated).toBe(false)
  })

  it("survives a failed probe as 'found nothing' rather than a dead end", async () => {
    probeVendors.mockRejectedValue(new Error("no ipc"))
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(result.current.result.runtimes).toEqual([]))
    expect(result.current.result.capabilities).toContain("web")
  })

  it("re-probes on rescan", async () => {
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(probeVendors).toHaveBeenCalledTimes(1))
    act(() => result.current.rescan())
    await waitFor(() => expect(probeVendors).toHaveBeenCalledTimes(2))
  })

  it("grants fs on the desktop but withholds ocr when a pinned provider is disabled", async () => {
    ocrSettings = { defaultProviderId: "mistral-ocr", providerEnabled: {} }
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(result.current.result.capabilities).toEqual(["fs", "web"]))
  })

  it("grants ocr once the pinned provider is enabled", async () => {
    ocrSettings = { defaultProviderId: "mistral-ocr", providerEnabled: { "mistral-ocr": true } }
    const { result } = renderHook(() => useMachineScan("tauri"))
    await waitFor(() => expect(result.current.result.capabilities).toEqual(["fs", "ocr", "web"]))
  })
})
