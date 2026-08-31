import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"

const actions = {
  create: jest.fn().mockResolvedValue("new-id"),
  provision: jest.fn().mockResolvedValue(undefined),
  start: jest.fn().mockResolvedValue(undefined),
  suspend: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  refreshHealth: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
}

let connections: unknown[] = []

jest.mock("@/hooks/automation/use-sandbox-connections", () => ({
  useSandboxConnections: () => ({ connections, update: jest.fn(), ...actions }),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import { SandboxConnectionsTab } from "@/components/settings/automation/sandbox-connections-tab"

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <SandboxConnectionsTab />
    </NextIntlClientProvider>
  )
}

function dockerRow(overrides: Partial<SandboxConnectionRow> = {}) {
  return {
    id: "c1",
    name: "home",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "img", host: "127.0.0.1", port: 0 },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  connections = []
})

test("renders an existing connection row with its status", () => {
  connections = [
    dockerRow({
      name: "home-docker",
      config: {
        provider: "docker",
        image: "ghcr.io/trycua/cua-xfce:latest",
        host: "127.0.0.1",
        port: 49160,
      },
      state: "running",
      lastHealthStatus: "ok",
    }),
  ]
  renderTab()
  expect(screen.getByText("home-docker")).toBeInTheDocument()
  // Lifecycle state and health are different questions, so they must not
  // render the same word. "Running" is the machine, "Reachable" is the probe.
  expect(screen.getByTestId("sandbox-state-c1")).toHaveTextContent("Running")
  expect(screen.getByText("Reachable")).toBeInTheDocument()
})

test("shows lifecycle state separately from health", () => {
  // A suspended machine is perfectly fine, and a running one can still be
  // unreachable. One badge cannot answer both questions.
  connections = [dockerRow({ state: "suspended", lastHealthStatus: "unknown" })]
  renderTab()
  const badge = screen.getByTestId("sandbox-state-c1")
  expect(badge).toHaveAttribute("data-state", "suspended")
  expect(badge).toHaveTextContent("Suspended")
  expect(screen.getByText("Unknown")).toBeInTheDocument()
})

test("add flow creates a connection with the typed name", async () => {
  renderTab()
  fireEvent.click(screen.getByText("Add connection"))
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "lab" } })
  fireEvent.click(screen.getByText("Save"))
  await waitFor(() =>
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" }))
  )
})

test("add flow freezes the container policy onto the new machine", async () => {
  renderTab()
  fireEvent.click(screen.getByText("Add connection"))
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "confined" } })
  fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "none" } })
  fireEvent.change(screen.getByLabelText("CPU limit"), { target: { value: "1.5" } })
  fireEvent.change(screen.getByLabelText("Memory limit (MiB)"), { target: { value: "2048" } })
  fireEvent.change(screen.getByLabelText("Host directory to mount"), {
    target: { value: "/host/ws" },
  })
  fireEvent.click(screen.getByText("Save"))
  await waitFor(() =>
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        networkMode: "none",
        cpus: "1.5",
        memoryMb: 2048,
        workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
      })
    )
  )
})

test("a half-specified mount is dropped rather than guessed", async () => {
  renderTab()
  fireEvent.click(screen.getByText("Add connection"))
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "partial" } })
  fireEvent.change(screen.getByLabelText("Path inside the machine"), { target: { value: "" } })
  fireEvent.change(screen.getByLabelText("Host directory to mount"), {
    target: { value: "/host/ws" },
  })
  fireEvent.click(screen.getByText("Save"))
  await waitFor(() => expect(actions.create).toHaveBeenCalled())
  expect(actions.create.mock.calls[0][0]).not.toHaveProperty("workspaceMount")
})

test("lifecycle actions live behind Manage and reach the hook", async () => {
  connections = [dockerRow({ state: "uninitialized" })]
  renderTab()
  fireEvent.click(screen.getByTestId("sandbox-manage-c1"))
  fireEvent.click(await screen.findByTestId("sandbox-action-start"))
  await waitFor(() => expect(actions.start).toHaveBeenCalledWith("c1"))
})

test("renders imported cloud and Lume config without exposing unsupported actions", async () => {
  connections = [
    {
      id: "cloud",
      name: "cloud desk",
      provider: "cua-cloud",
      driver: "cua-driver",
      config: { provider: "cua-cloud", instanceName: "desk-1", region: "us-west" },
      state: "stopped",
      capabilities: defaultSandboxCapabilities("cua-cloud", "cua-driver"),
      lastHealthStatus: "unknown",
      createdAt: 1,
      updatedAt: 1,
    },
  ]

  renderTab()
  expect(screen.getByText("desk-1")).toBeInTheDocument()

  // The row is still manageable, because hiding it would leave the operator
  // with a connection they cannot inspect or delete. Every action inside is
  // disabled instead, with the reason stated.
  fireEvent.click(screen.getByTestId("sandbox-manage-cloud"))
  const detail = await screen.findByTestId("sandbox-connection-detail")
  for (const button of detail.querySelectorAll("button[data-testid^='sandbox-action-']")) {
    expect(button).toBeDisabled()
  }
})
