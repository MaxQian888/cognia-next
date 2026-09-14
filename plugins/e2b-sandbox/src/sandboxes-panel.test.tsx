/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import { E2BSandboxPool } from "./sandbox-pool"
import { SandboxesPanel } from "./sandboxes-panel"
import { clearE2BPanelRuntime, setE2BPanelRuntime, type E2BPanelRuntime } from "./panel-runtime"

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
  apiKey: "keyring" | "pending" | "missing" = "keyring"
): E2BPanelRuntime {
  return {
    pool,
    ui: { showToast: jest.fn() },
    getConnectionStatus: () => ({ endpoint: "", kind: "cloud", apiKey }),
  }
}

afterEach(() => clearE2BPanelRuntime())

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
    expect(screen.getByText(/Provisioning unavailable in this build/)).toBeInTheDocument()
    expect(screen.getByText("No live E2B workspaces")).toBeInTheDocument()
  })

  it("renders one row per workspace with sandbox id, network, session, owners", () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/tmp/cognia/repo/aaa", sandbox("sbx-1"), "on")
    pool.claim("runtime:a", "/tmp/cognia/repo/aaa", "sess-1")
    pool.addWorkspace("/tmp/cognia/repo/bbb", sandbox("sbx-2"), "off")
    setE2BPanelRuntime(runtimeWith(pool))

    render(<SandboxesPanel {...PROPS} />)
    expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")).toHaveTextContent("sbx-1")
    expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")).toHaveTextContent(
      "Session sess-1"
    )
    expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/aaa")).toHaveTextContent(
      "1 runtime owner(s)"
    )
    expect(screen.getByTestId("sandbox-row-/tmp/cognia/repo/bbb")).toHaveTextContent("network off")
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
