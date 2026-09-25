/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
}))
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: jest.fn(),
  isMirroredPluginClient: jest.fn(() => false),
}))
jest.mock("./use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: jest.fn(() => "tauri"),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

import { toast } from "sonner"
import { setPluginEnabledForHost } from "@/lib/plugin/core/set-plugin-enabled-for-host"

import { pluginEnableFailureToastId } from "./plugin-links"
import { usePluginEnableAction } from "./use-plugin-enable-action"
import { usePluginRuntimeProfile } from "./use-plugin-runtime-profile"

const setEnabled = setPluginEnabledForHost as jest.Mock
const plugin = { id: "web", name: "Web Tools", manifest: { id: "web" } }

beforeEach(() => {
  jest.clearAllMocks()
  ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("tauri")
})

async function run(next: boolean, target: typeof plugin | Record<string, unknown> = plugin) {
  const { result } = renderHook(() => usePluginEnableAction())
  let out: unknown
  await act(async () => {
    out = await result.current(target as typeof plugin, next)
  })
  return out
}

describe("usePluginEnableAction", () => {
  it("offers to show what an enabled plugin contributed", async () => {
    setEnabled.mockResolvedValue({ ok: true, queued: false })
    await run(true)
    expect(setEnabled).toHaveBeenCalledWith("web", true, "manual")
    const [title, opts] = (toast.success as jest.Mock).mock.calls[0]
    expect(title).toBe("Web Tools enabled")
    expect(opts.action.label).toBe("View contributions")
    opts.action.onClick()
    expect(push).toHaveBeenCalledWith("/plugins?plugin=web&subtab=capabilities")
  })

  it("says a mirrored toggle was queued rather than applied", async () => {
    setEnabled.mockResolvedValue({ ok: true, queued: true })
    await run(true)
    expect(toast.message).toHaveBeenCalledWith(
      "Web Tools will be enabled on your desktop",
      expect.objectContaining({ description: expect.stringContaining("desktop") })
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("reports a failure with a localized reason, the shared toast id, and View details", async () => {
    const message = "Plugin not found: web"
    setEnabled.mockResolvedValue({ ok: false, queued: false, error: message })
    await run(true)
    const [title, opts] = (toast.error as jest.Mock).mock.calls[0]
    expect(title).toBe("Couldn't enable Web Tools")
    expect(opts.id).toBe(pluginEnableFailureToastId("web", message))
    expect(opts.description).toBe("It's no longer installed.")
    opts.action.onClick()
    expect(push).toHaveBeenCalledWith("/plugins?plugin=web")
  })

  it("refuses to enable a plugin this host cannot run", async () => {
    ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("browser")
    const out = await run(true, {
      ...plugin,
      manifest: { id: "web", runtimeCompatibility: { browser: { availability: "unsupported" } } },
    })
    expect(out).toBeNull()
    expect(setEnabled).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it("still lets a blocked plugin be disabled", async () => {
    ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("browser")
    setEnabled.mockResolvedValue({ ok: true, queued: false })
    await run(false, {
      ...plugin,
      manifest: { id: "web", runtimeCompatibility: { browser: { availability: "unsupported" } } },
    })
    expect(setEnabled).toHaveBeenCalledWith("web", false, "manual")
    expect(toast.success).toHaveBeenCalledWith("Web Tools disabled")
  })
})
