/**
 * @jest-environment jsdom
 *
 * Tests for the composer quick-actions dropdown: hidden when empty,
 * lists composer-surface actions, dispatches through runQuickAction.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { PluginQuickActionsMenu } from "./plugin-quick-actions-menu"
import {
  __resetQuickActionsForTesting,
  registerQuickAction,
} from "@/lib/plugin/registries/quick-action-registry"
import { __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"
import { defaultSnapshot } from "@/lib/tray/sync"

jest.mock("@/lib/tray/state-snapshot", () => ({
  useTrayStateSnapshot: () => defaultSnapshot(),
}))

const messages = {
  chat: { composer: { toolbar: { quickActions: "Plugin quick actions" } } },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  __resetQuickActionsForTesting()
  __resetCommandRegistryForTesting()
})

describe("PluginQuickActionsMenu", () => {
  it("renders nothing when no plugin contributed composer actions", () => {
    const { container } = wrap(<PluginQuickActionsMenu />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists composer-surface actions and dispatches on select", async () => {
    const user = userEvent.setup()
    const run = jest.fn()
    registerQuickAction("plug-a", {
      id: "summarize",
      title: "Summarize chat",
      description: "Send /summarize",
      run,
    })
    registerQuickAction("plug-a", {
      id: "tray-only",
      title: "Tray only",
      run: () => {},
      surfaces: ["tray"],
    })
    wrap(<PluginQuickActionsMenu />)

    await user.click(screen.getByRole("button", { name: "Plugin quick actions" }))
    expect(screen.queryByText("Tray only")).not.toBeInTheDocument()
    await user.click(await screen.findByText("Summarize chat"))

    expect(run).toHaveBeenCalled()
  })

  it("disables the trigger while streaming", () => {
    registerQuickAction("plug-a", { id: "x", title: "X", run: () => {} })
    wrap(<PluginQuickActionsMenu disabled />)

    expect(screen.getByRole("button", { name: "Plugin quick actions" })).toBeDisabled()
  })
})
