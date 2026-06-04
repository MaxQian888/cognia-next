/**
 * @jest-environment jsdom
 *
 * Tests for the chat-message plugin context-menu dropdown: hidden when
 * empty, zone filtering, CustomEvent dispatch with the message click
 * context, disabled handling.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { MessagePluginMenu } from "./message-plugin-menu"
import {
  __resetContextMenuRegistryForTesting,
  registerContextMenuItem,
} from "@/lib/plugin/context-menu/registry"

const messages = { chat: { message: { pluginMenu: "Plugin actions" } } }

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  __resetContextMenuRegistryForTesting()
})

describe("MessagePluginMenu", () => {
  it("renders nothing when no plugin contributed chat:message items", () => {
    const { container } = wrap(<MessagePluginMenu messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists chat:message items and dispatches the CustomEvent with the click context", async () => {
    const user = userEvent.setup()
    const handler = jest.fn()
    window.addEventListener("plugin-context-menu:p:translate", ((e: CustomEvent) =>
      handler(e.detail)) as EventListener)
    registerContextMenuItem({
      id: "p:translate",
      pluginId: "p",
      item: { id: "p:translate", label: "Translate", when: "chat:message", onClick: () => {} },
    })
    registerContextMenuItem({
      id: "p:canvas-only",
      pluginId: "p",
      item: { id: "p:canvas-only", label: "Canvas only", when: "canvas", onClick: () => {} },
    })
    wrap(<MessagePluginMenu messageId="m1" sessionId="s1" selection="hello" />)

    await user.click(screen.getByRole("button", { name: "Plugin actions" }))
    expect(screen.queryByText("Canvas only")).not.toBeInTheDocument()
    await user.click(await screen.findByText("Translate"))

    expect(handler).toHaveBeenCalledWith({
      target: "chat:message",
      messageId: "m1",
      sessionId: "s1",
      selection: "hello",
    })
  })

  it("renders disabled items as disabled", async () => {
    const user = userEvent.setup()
    registerContextMenuItem({
      id: "p:off",
      pluginId: "p",
      item: {
        id: "p:off",
        label: "Disabled item",
        when: "chat:message",
        disabled: true,
        onClick: () => {},
      },
    })
    wrap(<MessagePluginMenu messageId="m1" />)

    await user.click(screen.getByRole("button", { name: "Plugin actions" }))

    const item = await screen.findByText("Disabled item")
    expect(item.closest("[role='menuitem']")).toHaveAttribute("aria-disabled", "true")
  })
})
