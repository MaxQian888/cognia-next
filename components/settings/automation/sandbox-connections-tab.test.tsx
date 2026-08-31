import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"

const create = jest.fn().mockResolvedValue("new-id")
const start = jest.fn().mockResolvedValue(undefined)
const remove = jest.fn().mockResolvedValue(undefined)

let connections: unknown[] = []

jest.mock("@/hooks/automation/use-sandbox-connections", () => ({
  useSandboxConnections: () => ({
    connections,
    create,
    update: jest.fn(),
    remove,
    start,
    stop: jest.fn(),
    refreshHealth: jest.fn(),
  }),
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

beforeEach(() => {
  jest.clearAllMocks()
  connections = []
})

test("renders an existing connection row with its status", () => {
  connections = [
    {
      id: "c1",
      name: "home-docker",
      provider: "docker",
      driver: "computer-server",
      config: {
        provider: "docker",
        image: "ghcr.io/trycua/cua-xfce:latest",
        host: "127.0.0.1",
        port: 49160,
      },
      state: "running",
      capabilities: defaultSandboxCapabilities("docker", "computer-server"),
      lastHealthStatus: "ok",
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  renderTab()
  expect(screen.getByText("home-docker")).toBeInTheDocument()
  expect(screen.getByText("Running")).toBeInTheDocument()
})

test("add flow creates a connection with the typed name", async () => {
  renderTab()
  fireEvent.click(screen.getByText("Add connection"))
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "lab" } })
  fireEvent.click(screen.getByText("Save"))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" })))
})

test("start button calls the hook's start action", async () => {
  connections = [
    {
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
    },
  ]
  renderTab()
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(start).toHaveBeenCalledWith("c1"))
})

test("renders imported cloud and Lume config without exposing unsupported actions", () => {
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
    {
      id: "lume",
      name: "local vm",
      provider: "lume",
      driver: "cua-driver",
      config: { provider: "lume", vmName: "dev-vm", image: "macos-sequoia" },
      state: "stopped",
      capabilities: defaultSandboxCapabilities("lume", "cua-driver"),
      lastHealthStatus: "unknown",
      createdAt: 1,
      updatedAt: 1,
    },
  ]

  renderTab()

  expect(screen.getByText("desk-1")).toBeInTheDocument()
  expect(screen.getByText("dev-vm · macos-sequoia")).toBeInTheDocument()
  for (const button of screen.getAllByRole("button", { name: /Start|Stop|Check health|Delete/ })) {
    expect(button).toBeDisabled()
  }
})
