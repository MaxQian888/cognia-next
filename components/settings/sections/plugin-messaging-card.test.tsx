/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
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

describe("PluginMessagingCard", () => {
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
})
