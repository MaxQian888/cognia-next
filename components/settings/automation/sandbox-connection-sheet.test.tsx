import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import {
  SandboxConnectionSheet,
  type SandboxConnectionActions,
} from "@/components/settings/automation/sandbox-connection-sheet"

function actions(): jest.Mocked<SandboxConnectionActions> {
  return {
    provision: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    suspend: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    refreshHealth: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  }
}

function row(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "c1",
    name: "home",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "img", host: "127.0.0.1", port: 0 },
    state: "running",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function renderSheet(
  connection: SandboxConnectionRow | null,
  opts: {
    desktop?: boolean
    acts?: jest.Mocked<SandboxConnectionActions>
    onError?: jest.Mock
  } = {}
) {
  const acts = opts.acts ?? actions()
  const onError = opts.onError ?? jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <SandboxConnectionSheet
        connection={connection}
        open
        onOpenChange={jest.fn()}
        desktop={opts.desktop ?? true}
        actions={acts}
        onError={onError}
      />
    </NextIntlClientProvider>
  )
  return { acts, onError }
}

test("renders nothing without a connection", () => {
  renderSheet(null)
  expect(screen.queryByTestId("sandbox-connection-detail")).not.toBeInTheDocument()
})

test("dispatches each lifecycle action to the matching handler", async () => {
  const { acts } = renderSheet(row())
  for (const [testId, handler] of [
    ["sandbox-action-start", acts.start],
    ["sandbox-action-suspend", acts.suspend],
    ["sandbox-action-health", acts.refreshHealth],
    ["sandbox-action-delete", acts.remove],
  ] as const) {
    fireEvent.click(screen.getByTestId(testId))
    await waitFor(() => expect(handler).toHaveBeenCalledWith("c1"))
  }
})

test("suspend and delete are distinct actions, not aliases of stop", async () => {
  // `docker pause` is a suspend and `docker rm` is a delete. Wiring either to
  // stop would silently reboot or silently keep the machine.
  const { acts } = renderSheet(row())
  fireEvent.click(screen.getByTestId("sandbox-action-suspend"))
  await waitFor(() => expect(acts.suspend).toHaveBeenCalled())
  expect(acts.stop).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId("sandbox-action-delete"))
  await waitFor(() => expect(acts.remove).toHaveBeenCalled())
  expect(acts.stop).not.toHaveBeenCalled()
})

test("disables every action off the desktop, because Docker orchestration is client-local", () => {
  renderSheet(row(), { desktop: false })
  const detail = screen.getByTestId("sandbox-connection-detail")
  const buttons = [...detail.querySelectorAll("button[data-testid^='sandbox-action-']")]
  expect(buttons).not.toHaveLength(0)
  for (const button of buttons) expect(button).toBeDisabled()
})

test("disables actions the provider has no adapter for", () => {
  renderSheet(
    row({
      provider: "cua-cloud",
      config: { provider: "cua-cloud", instanceName: "desk" },
      capabilities: defaultSandboxCapabilities("cua-cloud", "cua-driver"),
      driver: "cua-driver",
    })
  )
  const detail = screen.getByTestId("sandbox-connection-detail")
  for (const button of detail.querySelectorAll("button[data-testid^='sandbox-action-']")) {
    expect(button).toBeDisabled()
  }
})

test("surfaces an action failure instead of swallowing it", async () => {
  const acts = actions()
  acts.start.mockRejectedValueOnce(new Error("Docker daemon not reachable"))
  const { onError } = renderSheet(row(), { acts })
  fireEvent.click(screen.getByTestId("sandbox-action-start"))
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Docker daemon not reachable"))
})

test("shows the frozen container policy", () => {
  renderSheet(
    row({
      config: {
        provider: "docker",
        image: "img",
        host: "127.0.0.1",
        port: 1,
        networkMode: "none",
        cpus: "1.5",
        memoryMb: 2048,
        workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
      },
    })
  )
  const policy = screen.getByTestId("sandbox-container-policy")
  expect(policy).toHaveTextContent("Off (isolated)")
  expect(policy).toHaveTextContent("1.5")
  expect(policy).toHaveTextContent("2048 MiB")
  expect(policy).toHaveTextContent("/host/ws → /workspace")
})

test("says plainly when no host directory is mounted", () => {
  // Without a mount there is no host path shell or file work can reach, and
  // an empty field would read as "unknown" rather than "none".
  renderSheet(row())
  expect(screen.getByTestId("sandbox-container-policy")).toHaveTextContent(
    "Shell and file work cannot reach any host path"
  )
})

test("keeps the last diagnostic visible", () => {
  renderSheet(row({ lastHealthError: "container exited with code 1" }))
  expect(screen.getByText("container exited with code 1")).toBeInTheDocument()
})

/**
 * `t(`state.${state}`)` is a dynamic key, and `lint:i18n` only checks literal
 * ones. Without this the vocabulary could grow a state with no label and the
 * gate would stay green while the sheet rendered a raw key.
 */
test("every lifecycle state has a label in both locales", () => {
  const states: SandboxLifecycleState[] = [
    "uninitialized",
    "creating",
    "stopped",
    "starting",
    "running",
    "suspending",
    "suspended",
    "resuming",
    "stopping",
    "deleting",
    "error",
  ]
  for (const messages of [en, zhCN] as unknown as Record<string, never>[]) {
    const labels = (
      messages as unknown as {
        automation: { sandboxConnections: { state: Record<string, string> } }
      }
    ).automation.sandboxConnections.state
    for (const state of states) {
      expect(typeof labels[state]).toBe("string")
      expect(labels[state].length).toBeGreaterThan(0)
    }
    expect(Object.keys(labels).sort()).toEqual([...states].sort())
  }
})
