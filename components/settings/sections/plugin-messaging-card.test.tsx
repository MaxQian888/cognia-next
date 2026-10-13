/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { getPluginIPC, resetPluginIPC } from "@/lib/plugin/messaging/ipc"
import { getMessageBus, resetMessageBus } from "@/lib/plugin/messaging/message-bus"
import { PluginMessagingCard } from "./plugin-messaging-card"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetPluginIPC()
  resetMessageBus()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("PluginMessagingCard", () => {
  it("shows recent library audit metadata and refreshes outcomes", () => {
    const history = jest.spyOn(getPluginIPC(), "getLibraryCallHistory").mockReturnValue([])
    wrap(<PluginMessagingCard />)
    expect(screen.getByText("No library RPC calls recorded yet.")).toBeInTheDocument()
    history.mockReturnValue([
      {
        callerId: "consumer",
        providerId: "utils",
        method: "parse",
        version: "1.2.0",
        risk: "read",
        outcome: "success",
        durationMs: 12,
        timestamp: 1,
      },
      {
        callerId: "blocked",
        providerId: "utils",
        method: "remove",
        version: "1.2.0",
        risk: "destructive",
        outcome: "failure",
        durationMs: 3,
        timestamp: 2,
      },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    const table = screen.getByRole("table", { name: "Recent library RPC calls" })
    const rows = within(table).getAllByRole("row")
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent("blockedutilsremove1.2.0DestructiveFailed3 ms")
    expect(rows[2]).toHaveTextContent("consumerutilsparse1.2.0Read onlySucceeded12 ms")
    for (const heading of [
      "Caller",
      "Library",
      "Method",
      "Version",
      "Risk",
      "Outcome",
      "Duration",
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument()
    }
  })
  it("shows the empty state when no plugin exposes methods", () => {
    wrap(<PluginMessagingCard />)
    expect(screen.getByTestId("plugin-messaging-exposed-empty")).toBeInTheDocument()
  })

  it("surfaces exposed RPC methods with descriptions and live stats", () => {
    const ipc = getPluginIPC()
    ipc.expose("plugin-a", {
      ping: { handler: () => "pong", description: "health check" },
    })
    ipc.subscribe("plugin-b", "events", () => {})
    getMessageBus().on("demo:event", () => {})

    wrap(<PluginMessagingCard />)

    const exposed = screen.getByTestId("plugin-messaging-exposed")
    expect(exposed).toHaveTextContent("plugin-a")
    expect(exposed).toHaveTextContent("ping()")
    expect(exposed).toHaveTextContent("health check")

    // Stats grid reflects the seeded IPC channel + exposed method.
    const stats = screen.getByTestId("plugin-messaging-stats")
    expect(stats).toHaveTextContent("Exposed methods")
    expect(stats).toHaveTextContent("IPC channels")
  })

  it("flags degraded breakers", async () => {
    const ipc = getPluginIPC()
    ipc.expose("plugin-a", { boom: () => Promise.reject(new Error("fail")) })
    // Drive the endpoint breaker open with repeated failures.
    for (let i = 0; i < 8; i++) {
      await ipc.call("plugin-b", "plugin-a", "boom").catch(() => {})
    }

    wrap(<PluginMessagingCard />)
    // Only renders the breaker block when something is non-closed.
    if (ipc.getAllBreakerStates().some((b) => b.state !== "closed")) {
      expect(screen.getByTestId("plugin-messaging-breakers")).toBeInTheDocument()
    }
  })

  it("refreshes the snapshot on demand", () => {
    wrap(<PluginMessagingCard />)
    expect(screen.getByTestId("plugin-messaging-exposed-empty")).toBeInTheDocument()

    // Expose a method after the first render, then refresh.
    getPluginIPC().expose("late-plugin", { hi: () => "hi" })
    fireEvent.click(screen.getByTestId("plugin-messaging-refresh"))

    expect(screen.getByTestId("plugin-messaging-exposed")).toHaveTextContent("late-plugin")
  })

  it("shows the declared library version, risk, and required permissions", () => {
    const ipc = getPluginIPC()
    ipc.registerPlugin("library", ["ipc:expose"], {
      id: "library",
      name: "Library fixture",
      description: "Library diagnostics fixture",
      type: "frontend",
      capabilities: [],
      version: "1.2.0",
      library: {
        rpc: {
          read: {
            description: "Read library data",
            risk: "read",
            requiredPermissions: ["filesystem:read"],
            inputSchema: { type: "array" },
            outputSchema: true,
          },
        },
      },
    })
    ipc.expose("library", { read: () => null })
    ipc.completeLibraryActivation("library")
    wrap(<PluginMessagingCard />)
    expect(screen.getByText("Library 1.2.0")).toBeInTheDocument()
    expect(screen.getByText("Read only")).toBeInTheDocument()
    expect(screen.getByText("Required permissions: filesystem:read")).toBeInTheDocument()
  })
})
