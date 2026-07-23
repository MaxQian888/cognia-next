/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginContext } from "@/types/plugin"
import type { ContextPanelRenderProps } from "@/types/context-workbench"
import { createTemplatesPanel, readAllTemplates } from "./templates-panel"

function makeCtx(seed: Record<string, string> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed))
  const writeText = jest.fn(async () => {})
  const showToast = jest.fn()
  const ctx = {
    pluginId: "cognia-prompt-templates",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    storage: {
      get: async (key: string) => store.get(key),
      keys: async () => Array.from(store.keys()),
    },
    clipboard: { writeText },
    ui: { showToast },
  } as unknown as PluginContext
  return { ctx, store, writeText, showToast }
}

const renderProps: ContextPanelRenderProps = {
  workbenchInstanceId: "window-a",
  resource: { kind: "session", sessionId: "s-1", capabilities: [] },
  active: true,
}

describe("templates panel", () => {
  it("lists stored templates in name order, ignoring unrelated storage keys", async () => {
    const { ctx } = makeCtx({
      "template:zebra": "last body",
      unrelated: "not a template",
      "template:alpha": "first body",
    })

    expect(await readAllTemplates(ctx)).toEqual([
      { name: "alpha", body: "first body" },
      { name: "zebra", body: "last body" },
    ])
  })

  it("copies the body and confirms which template it copied", async () => {
    const { ctx, writeText, showToast } = makeCtx({ "template:greeting": "hello there" })
    const Panel = createTemplatesPanel(ctx)
    render(<Panel {...renderProps} />)

    const row = await screen.findByRole("button", { name: /greeting/ })
    await userEvent.click(row)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello there"))
    expect(showToast).toHaveBeenCalledWith('Copied template "greeting".', "success")
  })

  it("surfaces a failed copy instead of pretending it worked", async () => {
    const { ctx, showToast } = makeCtx({ "template:greeting": "hello there" })
    ;(ctx.clipboard as unknown as { writeText: jest.Mock }).writeText.mockRejectedValue(
      new Error("denied")
    )
    const Panel = createTemplatesPanel(ctx)
    render(<Panel {...renderProps} />)

    await userEvent.click(await screen.findByRole("button", { name: /greeting/ }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not copy template "greeting".', "error")
    )
  })

  it("points at the command that creates one when there are none", async () => {
    const { ctx } = makeCtx()
    const Panel = createTemplatesPanel(ctx)
    render(<Panel {...renderProps} />)

    expect(await screen.findByText("No prompt templates yet")).toBeInTheDocument()
  })

  it("re-reads storage on re-activation, since slash commands write while it is hidden", async () => {
    const { ctx, store } = makeCtx()
    const Panel = createTemplatesPanel(ctx)
    const { rerender } = render(<Panel {...renderProps} active={false} />)

    store.set("template:added-later", "body")
    rerender(<Panel {...renderProps} active />)

    expect(await screen.findByRole("button", { name: /added-later/ })).toBeInTheDocument()
  })
})
