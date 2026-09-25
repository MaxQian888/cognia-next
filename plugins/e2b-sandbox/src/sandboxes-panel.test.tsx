/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import { E2BSandboxPool } from "./sandbox-pool"
import { RELEASE_CONFIRM_RESET_MS, SandboxesPanel, shortId } from "./sandboxes-panel"
import { clearE2BPanelRuntime, setE2BPanelRuntime, type E2BPanelRuntime } from "./panel-runtime"

/** Register the plugin's own bundle the way the manager does on enable. */
function registerBundle(): void {
  const messages: Record<string, Record<string, string>> = {}
  for (const [locale, dict] of Object.entries(manifestJson.i18n.locales)) {
    messages[locale] = Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
    )
  }
  registerPluginI18n({ pluginId: PLUGIN_ID, messages })
}

const PROPS: ContextPanelRenderProps = {
  workbenchInstanceId: "wb-1",
  resource: { kind: "session", sessionId: "sess-1" },
  active: true,
} as ContextPanelRenderProps

function sandbox(id: string) {
  return {
    id,
    exec: jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    close: jest.fn<Promise<void>, []>(async () => undefined),
  }
}

function runtimeWith(
  pool: E2BSandboxPool,
  apiKey: "keyring" | "pending" | "missing" = "keyring",
  provisioningAvailable = false
): E2BPanelRuntime {
  return {
    pool,
    ui: { showToast: jest.fn() },
    provisioningAvailable,
    getConnectionStatus: () => ({ endpoint: "", kind: "cloud", apiKey }),
  }
}

beforeEach(() => registerBundle())

afterEach(() => {
  clearE2BPanelRuntime()
  unregisterPluginI18n(PLUGIN_ID)
  jest.useRealTimers()
})

describe("SandboxesPanel", () => {
  it("explains itself when the plugin runtime is not parked", () => {
    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByText("The E2B Sandbox plugin is not active.")).toBeInTheDocument()
  })

  it("shows the connection status and an empty-state explainer", () => {
    setE2BPanelRuntime(runtimeWith(new E2BSandboxPool()))
    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByText("Sandboxes")).toBeInTheDocument()
    expect(screen.getByText("E2B Cloud")).toBeInTheDocument()
    expect(screen.getByText("API key stored in the OS keyring")).toBeInTheDocument()
    expect(screen.getByTestId("e2b-provisioning-inactive")).toHaveTextContent(
      /Inactive in this build/
    )
    expect(screen.getByText("No live E2B workspaces")).toBeInTheDocument()
  })

  it("drops the inactive label once provisioning is available", () => {
    setE2BPanelRuntime(runtimeWith(new E2BSandboxPool(), "keyring", true))
    render(<SandboxesPanel {...PROPS} />)
    expect(screen.queryByTestId("e2b-provisioning-inactive")).not.toBeInTheDocument()
  })

  it("renders one row per workspace with sandbox id, network, session, owners", () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/tmp/cognia/repo/aaa", sandbox("sbx-1"), "on")
    pool.claim("runtime:a", "/tmp/cognia/repo/aaa", "sess-1")
    pool.addWorkspace("/tmp/cognia/repo/bbb", sandbox("sbx-2"), "off")
    pool.claim("runtime:b", "/tmp/cognia/repo/bbb", "other-session")
    setE2BPanelRuntime(runtimeWith(pool))

    render(<SandboxesPanel {...PROPS} />)
    const current = screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")
    expect(current).toHaveTextContent("Sandbox sbx-1")
    // The viewer's own session reads as such, not as an id.
    expect(current).toHaveTextContent("This session")
    expect(current).toHaveTextContent("1 runtime owner(s)")
    const other = screen.getByTestId("sandbox-row-/tmp/cognia/repo/bbb")
    expect(other).toHaveTextContent("network off")
    expect(other).toHaveTextContent("Session other-se…")
    expect(screen.getByTitle("other-session")).toBeInTheDocument()
  })

  it("shortens long ids and keeps short ones whole", () => {
    expect(shortId("sbx-1")).toBe("sbx-1")
    expect(shortId("0123456789abcdef")).toBe("01234567…")
  })

  it("gives the release button a 36px touch target", () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/tmp/cognia/repo/aaa", sandbox("sbx-1"), "on")
    setE2BPanelRuntime(runtimeWith(pool))
    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByTestId("sandbox-release-/tmp/cognia/repo/aaa")).toHaveClass("min-h-9")
  })

  it("disarms an armed confirm on timeout, blur, and Escape", () => {
    jest.useFakeTimers()
    const pool = new E2BSandboxPool()
    const vm = sandbox("sbx-1")
    pool.addWorkspace("/tmp/cognia/repo/aaa", vm, "on")
    setE2BPanelRuntime(runtimeWith(pool))
    render(<SandboxesPanel {...PROPS} />)
    const release = screen.getByTestId("sandbox-release-/tmp/cognia/repo/aaa")

    fireEvent.click(release)
    expect(release).toHaveTextContent("Confirm release")
    expect(release).toHaveAccessibleName("Confirm releasing workspace /tmp/cognia/repo/aaa")
    act(() => {
      jest.advanceTimersByTime(RELEASE_CONFIRM_RESET_MS)
    })
    expect(release).toHaveTextContent("Release")
    expect(release).not.toHaveTextContent("Confirm")

    fireEvent.click(release)
    fireEvent.blur(release)
    expect(release).not.toHaveTextContent("Confirm")

    fireEvent.click(release)
    fireEvent.keyDown(release, { key: "Escape" })
    expect(release).not.toHaveTextContent("Confirm")
    expect(vm.close).not.toHaveBeenCalled()
  })

  it("releases a workspace only after the two-click confirm", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("sbx-1")
    pool.addWorkspace("/tmp/cognia/repo/aaa", vm, "on")
    setE2BPanelRuntime(runtimeWith(pool))
    render(<SandboxesPanel {...PROPS} />)

    const release = screen.getByTestId("sandbox-release-/tmp/cognia/repo/aaa")
    fireEvent.click(release) // arms the confirm — nothing closes yet
    expect(vm.close).not.toHaveBeenCalled()
    expect(screen.getByText("Confirm release")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Confirm release"))
    await waitFor(() => expect(vm.close).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId("sandbox-row-/tmp/cognia/repo/aaa")).not.toBeInTheDocument()
    )
    expect(screen.getByText("No live E2B workspaces")).toBeInTheDocument()
  })

  it("keeps a claimed workspace listed (released, not closed) and hides the release button", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("sbx-1")
    pool.addWorkspace("/tmp/cognia/repo/aaa", vm, "on")
    pool.claim("runtime:a", "/tmp/cognia/repo/aaa", "sess-1")
    await pool.removeWorkspace("/tmp/cognia/repo/aaa")
    setE2BPanelRuntime(runtimeWith(pool))

    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByText("handle released")).toBeInTheDocument()
    expect(screen.queryByTestId("sandbox-release-/tmp/cognia/repo/aaa")).not.toBeInTheDocument()
    expect(vm.close).not.toHaveBeenCalled()
  })

  it("re-renders when the pool mutates underneath a mounted panel", async () => {
    const pool = new E2BSandboxPool()
    setE2BPanelRuntime(runtimeWith(pool))
    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByText("No live E2B workspaces")).toBeInTheDocument()

    act(() => {
      pool.addWorkspace("/tmp/cognia/repo/aaa", sandbox("sbx-9"), "on")
    })
    await waitFor(() =>
      expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")).toBeInTheDocument()
    )
  })

  it("toasts instead of crashing when a release fails", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("sbx-1")
    vm.close.mockRejectedValueOnce(new Error("provider down"))
    pool.addWorkspace("/tmp/cognia/repo/aaa", vm, "on")
    const runtime = runtimeWith(pool)
    setE2BPanelRuntime(runtime)
    render(<SandboxesPanel {...PROPS} />)

    fireEvent.click(screen.getByTestId("sandbox-release-/tmp/cognia/repo/aaa"))
    fireEvent.click(screen.getByText("Confirm release"))
    await waitFor(() =>
      expect(runtime.ui?.showToast).toHaveBeenCalledWith(
        expect.stringContaining("/tmp/cognia/repo/aaa"),
        "error"
      )
    )
    // The failed entry stays listed so the release can be retried.
    expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")).toBeInTheDocument()
  })
})
