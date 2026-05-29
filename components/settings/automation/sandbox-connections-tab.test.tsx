import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

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
      image: "ghcr.io/trycua/cua-xfce:latest",
      host: "127.0.0.1",
      port: 49160,
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
      image: "img",
      host: "127.0.0.1",
      port: 0,
      lastHealthStatus: "unknown",
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  renderTab()
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(start).toHaveBeenCalledWith("c1"))
})
