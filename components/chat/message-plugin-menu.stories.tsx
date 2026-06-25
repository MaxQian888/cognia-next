import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, within, userEvent, waitFor } from "storybook/test"

import { MessagePluginMenu } from "./message-plugin-menu"
import {
  registerContextMenuItem,
  unregisterContextMenuItemsByPlugin,
} from "@/lib/plugin/context-menu/registry"
import type { ContextMenuItem } from "@/types/plugin"

// `MessagePluginMenu` is a hover dropdown surfacing plugin-contributed
// context-menu items registered for the `chat:message` zone. It reads the
// renderer-side registry via `usePluginContextMenuItems("chat:message")` and
// renders NOTHING when no plugin contributed items. Each story seeds the
// registry in `beforeEach` (and clears it first) so the trigger appears;
// clicking dispatches a `plugin-context-menu:<id>` CustomEvent — the demo
// handlers below are `fn()` spies.

const PLUGIN_ID = "storybook-demo"

const onTranslate = fn()
const onPin = fn()
const onReport = fn()

const item = (
  id: string,
  label: string,
  extra: Partial<ContextMenuItem> = {}
): ContextMenuItem => ({
  id,
  label,
  when: "chat:message",
  onClick: fn(),
  ...extra,
})

function seedItems(items: ContextMenuItem[]) {
  unregisterContextMenuItemsByPlugin(PLUGIN_ID)
  for (const it of items) {
    registerContextMenuItem({ id: it.id, pluginId: PLUGIN_ID, item: it })
  }
}

const meta = {
  title: "Chat/MessagePluginMenu",
  component: MessagePluginMenu,
  parameters: { layout: "padded" },
  args: {
    messageId: "m-42",
    sessionId: "demo-session",
    selection: "the closure captures its lexical scope",
  },
} satisfies Meta<typeof MessagePluginMenu>

export default meta
type Story = StoryObj<typeof meta>

// Three contributed items; the play function opens the dropdown so the menu
// content is visible in the static frame.
export const WithItems: Story = {
  beforeEach: () =>
    seedItems([
      item("translate", "Translate selection", { onClick: onTranslate }),
      item("pin", "Pin message", { onClick: onPin }),
      item("report", "Report to admin", { onClick: onReport }),
    ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Plugin actions" }))
    await waitFor(() => expect(document.body.textContent).toContain("Translate selection"))
  },
}

// One item is disabled — the menu item renders but is non-interactive.
export const WithDisabledItem: Story = {
  beforeEach: () =>
    seedItems([
      item("copy-quote", "Copy as quote"),
      item("report", "Report to admin", { disabled: true }),
    ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Plugin actions" }))
    await waitFor(() => expect(document.body.textContent).toContain("Copy as quote"))
  },
}

// No plugin contributed items — the component renders nothing (zero cost in
// the common case). The frame is intentionally empty.
export const NoItems: Story = {
  beforeEach: () => {
    unregisterContextMenuItemsByPlugin(PLUGIN_ID)
  },
}
