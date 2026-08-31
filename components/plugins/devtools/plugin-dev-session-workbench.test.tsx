/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import type { PluginRuntimeLogEntry } from "@/lib/plugin/devtools/runtime-log-stream"
import { useDevProjectStore } from "@/stores/plugins/dev-project-store"
import { usePluginDevSessionStore } from "@/stores/plugins/plugin-dev-session-store"

const mockStatus = jest.fn()
jest.mock("@/hooks/plugins/use-cognia-cli-status", () => ({
  useCogniaCliStatus: () => mockStatus(),
}))
jest.mock("./cognia-cli-status-card", () => ({
  CogniaCliStatusCard: () => <div data-testid="cli-status" />,
}))
jest.mock("./cognia-cli-launcher", () => ({
  CogniaCliLauncher: () => <div data-testid="cli-launcher" />,
}))
jest.mock("./manifest-validator", () => ({
  ManifestValidator: () => <div data-testid="manifest-validator" />,
}))
jest.mock("./local-plugin-dropzone", () => ({
  LocalPluginDropzone: () => <div data-testid="dropzone" />,
}))
jest.mock("../plugin-point-diagnostics-panel", () => ({
  PluginPointDiagnosticsPanel: () => <div data-testid="point-diagnostics" />,
}))
jest.mock("./api-audit-pane", () => ({
  ApiAuditPane: () => <div data-testid="api-audit" />,
}))
jest.mock("./lifecycle-pane", () => ({
  LifecyclePane: () => <div data-testid="lifecycle" />,
}))
jest.mock("./triggers-pane", () => ({
  TriggersPane: () => <div data-testid="triggers" />,
}))

const terminalWrite = jest.fn().mockResolvedValue(undefined)
let mockLiveSession: { isExited: boolean; write: typeof terminalWrite } | undefined
jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () => mockLiveSession,
}))
const mockLaunchCognia = jest.fn()
jest.mock("@/lib/terminal/run-cognia", () => ({
  launchCognia: (...args: unknown[]) => mockLaunchCognia(...args),
}))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))
const mockGetLogs = jest.fn()
const mockOnLog = jest.fn()
jest.mock("@/lib/plugin/devtools/runtime-log-stream", () => ({
  ...jest.requireActual("@/lib/plugin/devtools/runtime-log-stream"),
  getPluginRuntimeLogs: (...args: unknown[]) => mockGetLogs(...args),
  subscribePluginRuntimeLogs: (...args: unknown[]) => mockOnLog(...args),
  clearPluginRuntimeLogs: jest.fn(),
}))
const setPanelOpen = jest.fn()
const setActiveSession = jest.fn()
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ sessions: {}, setPanelOpen, setActiveSession }) },
}))

import { PluginDevSessionWorkbench } from "./plugin-dev-session-workbench"

function renderWorkbench() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginDevSessionWorkbench />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  mockLiveSession = { isExited: false, write: terminalWrite }
  mockGetLogs.mockReturnValue([])
  mockOnLog.mockReturnValue(jest.fn())
  usePluginDevSessionStore.getState().clear()
  useDevProjectStore.getState().clearProject()
  mockStatus.mockReturnValue({ supported: true })
})

describe("PluginDevSessionWorkbench", () => {
  it("shows generation and artifact proof only for a verified active attempt", () => {
    usePluginDevSessionStore.getState().recordReloadResult({
      schemaVersion: 1,
      ok: true,
      outcome: "activated",
      stage: "verify",
      sessionId: "session-a",
      attempt: 3,
      pluginId: "demo.plugin",
      pluginType: "frontend",
      activationProof: {
        previousGeneration: 2,
        generation: 3,
        actualState: "active",
        packageVersion: "1.2.0",
        artifactRevision: "sha256:abc",
        reloadMode: "hot",
      },
    })
    renderWorkbench()
    expect(screen.getByTestId("dev-session-activation-proof")).toHaveTextContent("Generation 3")
    expect(screen.getByTestId("dev-session-activation-proof")).toHaveTextContent("sha256:abc")
  })

  it("shows terminal actions only for an App-launched session and sends one interrupt", async () => {
    usePluginDevSessionStore.getState().attachTerminal("session-app", "terminal-1")
    renderWorkbench()
    expect(screen.getByTestId("dev-session-terminal-actions")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(terminalWrite).toHaveBeenCalledTimes(1)
    expect(terminalWrite).toHaveBeenCalledWith("\u0003")

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }))
    expect(setPanelOpen).toHaveBeenCalledWith(true)
    expect(setActiveSession).toHaveBeenCalledWith(null, "terminal-1")
  })

  it("reports an unavailable App terminal instead of claiming it stopped", async () => {
    mockLiveSession = undefined
    usePluginDevSessionStore.getState().attachTerminal("session-app", "terminal-1")
    renderWorkbench()

    await userEvent.click(screen.getByRole("button", { name: "Stop" }))

    expect(mockToastError).toHaveBeenCalledWith(
      enMessages.plugins.devSession.actions.terminalUnavailable
    )
    expect(terminalWrite).not.toHaveBeenCalled()
  })

  it("restarts an App session with a new correlated CLI session", async () => {
    useDevProjectStore.getState().setProject("/tmp/demo", "Demo")
    usePluginDevSessionStore.getState().attachTerminal("session-app", "terminal-1")
    mockLaunchCognia.mockResolvedValue({ kind: "launched", sessionId: "terminal-2" })
    jest.spyOn(crypto, "randomUUID").mockReturnValue("550e8400-e29b-41d4-a716-446655440000")
    renderWorkbench()

    await userEvent.click(screen.getByRole("button", { name: "Restart" }))

    expect(terminalWrite).toHaveBeenCalledWith("\u0003")
    expect(mockLaunchCognia).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "plugin dev --session-id 550e8400-e29b-41d4-a716-446655440000",
        cwd: "/tmp/demo",
      })
    )
    expect(usePluginDevSessionStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        id: "550e8400-e29b-41d4-a716-446655440000",
        terminalSessionId: "terminal-2",
      })
    )
  })

  it.each([
    [{ kind: "denied" }, enMessages.plugins.devSession.actions.launchDenied],
    [
      { kind: "error", message: "missing binary" },
      enMessages.plugins.devSession.actions.launchFailed.replace("{message}", "missing binary"),
    ],
  ])("shows a restart launch failure for %o", async (outcome, expectedMessage) => {
    useDevProjectStore.getState().setProject("/tmp/demo", "Demo")
    usePluginDevSessionStore.getState().attachTerminal("session-app", "terminal-1")
    mockLaunchCognia.mockResolvedValue(outcome)
    renderWorkbench()

    await userEvent.click(screen.getByRole("button", { name: "Restart" }))

    expect(mockToastError).toHaveBeenCalledWith(expectedMessage)
  })

  it("does not offer terminal actions for an external CLI session", () => {
    usePluginDevSessionStore.getState().ingest({
      schemaVersion: 1,
      sessionId: "external",
      attempt: 0,
      event: "session_started",
      projectName: "External Plugin Project",
      occurredAt: new Date().toISOString(),
    })
    renderWorkbench()
    expect(screen.queryByTestId("dev-session-terminal-actions")).not.toBeInTheDocument()
    expect(screen.getByText(/External Plugin Project/)).toBeInTheDocument()
  })

  it("keeps validation available while explaining that runtime activation needs Desktop", () => {
    mockStatus.mockReturnValue({ supported: false })
    renderWorkbench()
    expect(screen.getByTestId("dev-session-desktop-required")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-dev-session-workbench")).toBeInTheDocument()
  })

  describe("runtime logs", () => {
    function seedFailedReload(pluginType: "frontend" | "python" | "wasm" | "vscode-extension") {
      usePluginDevSessionStore.getState().recordReloadResult({
        schemaVersion: 1,
        ok: false,
        outcome: "failed",
        stage: "verify",
        sessionId: "session-a",
        attempt: 1,
        pluginId: "demo.plugin",
        pluginType,
        error: {
          code: "activation_failed",
          message: "boom",
          action: "retry",
          retriable: true,
        },
      })
    }

    it("shows every generation, and says so, when no activation has been verified", async () => {
      // The previous behaviour was to show nothing at all without an
      // activation proof, so a plugin whose reload kept failing gave its
      // author an empty card and no output to debug it with.
      seedFailedReload("frontend")
      mockGetLogs.mockReturnValue([
        {
          id: "log-1",
          pluginId: "demo.plugin",
          runtime: "frontend",
          generation: "2",
          level: "error",
          message: "threw during activate",
          timestamp: 1,
        },
      ])
      renderWorkbench()
      await userEvent.click(screen.getByRole("tab", { name: "Diagnostics" }))
      expect(await screen.findByText(/threw during activate/)).toBeInTheDocument()
      expect(screen.getByTestId("runtime-logs-scope")).toHaveTextContent(
        /No activation has been verified yet/
      )
      expect(mockGetLogs).toHaveBeenCalledWith("demo.plugin", { generation: null, limit: 200 })
    })

    it("tags each line with the runtime that produced it", async () => {
      // A hybrid plugin emits from two hosts at once.
      seedFailedReload("python")
      mockGetLogs.mockReturnValue([
        {
          id: "log-1",
          pluginId: "demo.plugin",
          runtime: "python",
          generation: null,
          level: "info",
          message: "from the host",
          timestamp: 1,
        },
      ])
      renderWorkbench()
      await userEvent.click(screen.getByRole("tab", { name: "Diagnostics" }))
      const line = await screen.findByText(/from the host/)
      expect(line.closest("li")).toHaveAttribute("data-runtime", "python")
    })

    it.each([
      ["wasm", /no per-plugin output channel/i],
      ["vscode-extension", /explicitly-unavailable list/i],
    ] as const)(
      "explains why %s produces no logs instead of showing an empty list",
      async (type, expected) => {
        seedFailedReload(type)
        renderWorkbench()
        await userEvent.click(screen.getByRole("tab", { name: "Diagnostics" }))
        expect(screen.getByTestId("runtime-logs-scope")).toHaveTextContent(expected)
        expect(mockGetLogs).not.toHaveBeenCalled()
      }
    )

    it("says nothing was logged rather than leaving the card blank", async () => {
      seedFailedReload("frontend")
      mockGetLogs.mockReturnValue([])
      renderWorkbench()
      await userEvent.click(screen.getByRole("tab", { name: "Diagnostics" }))
      expect(await screen.findByTestId("runtime-logs-empty")).toBeInTheDocument()
    })
  })

  it("shows attempt duration, diagnostics, and generation-filtered runtime logs", async () => {
    usePluginDevSessionStore.getState().ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 4,
      event: "build_failed",
      summary: "compile failed",
      durationMs: 321,
      occurredAt: new Date().toISOString(),
    })
    const initialLog: PluginRuntimeLogEntry = {
      id: "log-1",
      pluginId: "demo.plugin",
      runtime: "frontend",
      generation: "5",
      level: "info",
      message: "runtime ready",
      timestamp: 1,
    }
    let visible: PluginRuntimeLogEntry[] = [initialLog]
    mockGetLogs.mockImplementation(() => visible)
    let onChange: (() => void) | undefined
    mockOnLog.mockImplementation((_pluginId: string, handler: () => void) => {
      onChange = handler
      return jest.fn()
    })
    renderWorkbench()

    expect(screen.getByText("321 ms")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "Diagnostics" }))
    expect(await screen.findByText("compile failed")).toBeInTheDocument()
    act(() => {
      usePluginDevSessionStore.getState().recordReloadResult({
        schemaVersion: 1,
        ok: true,
        outcome: "activated",
        stage: "verify",
        sessionId: "session-a",
        attempt: 5,
        pluginId: "demo.plugin",
        pluginType: "frontend",
        activationProof: {
          previousGeneration: 4,
          generation: 5,
          actualState: "active",
          packageVersion: "1.0.0",
          artifactRevision: "sha256:five",
          reloadMode: "hot",
        },
      })
    })
    expect(await screen.findByText("runtime ready")).toBeInTheDocument()
    expect(mockGetLogs).toHaveBeenCalledWith("demo.plugin", { generation: 5, limit: 200 })

    act(() => {
      visible = [
        initialLog,
        { ...initialLog, id: "log-2", level: "error", message: "runtime failed" },
      ]
      onChange?.()
    })
    await waitFor(() => expect(screen.getByText(/runtime failed/)).toBeInTheDocument())

    await userEvent.click(screen.getByRole("tab", { name: "Advanced diagnostics" }))
    // Nothing else mounts the API audit reader, so an unmounted pane means
    // the audit ring goes back to having only the sampled trace bridge.
    expect(screen.getByTestId("api-audit")).toBeInTheDocument()
    expect(screen.getByTestId("lifecycle")).toBeInTheDocument()
    expect(screen.getByTestId("triggers")).toBeInTheDocument()
    expect(screen.getByTestId("point-diagnostics")).toBeInTheDocument()
  })
})
