/**
 * @jest-environment jsdom
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ContextPanelRenderProps, PluginContext } from "@cognia/plugin-sdk"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../plugin.json"
import { createTemplateStore } from "./template-store"
import { createTemplatesPanel, PLUGIN_ID } from "./templates-panel"

/** Register the plugin's own bundle the way the manager does on enable. */
function registerBundle() {
  const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(locales).map(([locale, dict]) => [
        locale,
        Object.fromEntries(
          Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
        ),
      ])
    ),
  })
}

function makeHarness(seed: Record<string, string> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed))
  const storage = {
    get: async <T,>(key: string) => map.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
    keys: async () => Array.from(map.keys()),
  }
  const store = createTemplateStore(storage)
  const writeText = jest.fn(async (_text: string) => {})
  const appendToComposer = jest.fn()
  const showToast = jest.fn()
  const ctx = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    clipboard: { writeText },
    chat: { appendToComposer },
    ui: { showToast },
  } as unknown as Pick<PluginContext, "chat" | "clipboard" | "ui" | "logger">
  return { ctx, map, store, storage, writeText, appendToComposer, showToast }
}

const renderProps: ContextPanelRenderProps = {
  workbenchInstanceId: "window-a",
  resource: { kind: "session", sessionId: "s-1", capabilities: [] },
  active: true,
}

beforeEach(() => registerBundle())
afterEach(() => {
  cleanup()
  unregisterPluginI18n(PLUGIN_ID)
})

describe("templates panel", () => {
  it("inserts the verbatim multi-line body into this chat's composer", async () => {
    const body = "Summarize:\n\n- point one\n- point two"
    const { ctx, store, appendToComposer, showToast } = makeHarness({ "template:summary": body })
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)

    const insert = await screen.findByRole("button", {
      name: 'Insert template "summary" into the composer',
    })
    // ≥ 36px touch target on small (touch) screens.
    expect(insert.className).toContain("h-9")
    await userEvent.click(insert)

    expect(appendToComposer).toHaveBeenCalledWith(body, { sessionId: "s-1" })
    expect(showToast).toHaveBeenCalledWith(
      'Inserted template "summary" into the composer.',
      "success"
    )
  })

  it("copies the body and confirms which template it copied", async () => {
    const { ctx, store, writeText, showToast } = makeHarness({
      "template:greeting": "hello there",
    })
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)

    const copy = await screen.findByRole("button", { name: 'Copy template "greeting"' })
    expect(copy.closest("ul")).toHaveClass("w-full", "min-w-0", "max-w-full", "overflow-x-hidden")
    await userEvent.click(copy)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello there"))
    expect(showToast).toHaveBeenCalledWith('Copied template "greeting".', "success")
  })

  it("surfaces a failed copy instead of pretending it worked", async () => {
    const { ctx, store, writeText, showToast } = makeHarness({ "template:greeting": "hi" })
    writeText.mockRejectedValue(new Error("denied"))
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)

    await userEvent.click(await screen.findByRole("button", { name: 'Copy template "greeting"' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not copy template "greeting".', "error")
    )
  })

  it("points at the command that creates one when there are none", async () => {
    const { ctx, store } = makeHarness()
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)

    expect((await screen.findByText("No prompt templates yet")).parentElement).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-x-hidden"
    )
    expect(screen.getByText("/template-add <name> <body>")).toBeInTheDocument()
  })

  it("shows a load failure with a working retry", async () => {
    const { ctx, store, storage } = makeHarness({ "template:a": "x" })
    const keys = jest.spyOn(storage, "keys").mockRejectedValueOnce(new Error("db closed"))
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your templates.")
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("a")).toBeInTheDocument()
    expect(keys).toHaveBeenCalledTimes(2)
  })

  it("re-reads storage on re-activation, since slash commands write while it is hidden", async () => {
    const { ctx, store, map } = makeHarness()
    const Panel = createTemplatesPanel(ctx, store)
    const { rerender } = render(<Panel {...renderProps} active={false} />)

    map.set("template:added-later", "body")
    rerender(<Panel {...renderProps} active />)

    expect(await screen.findByText("added-later")).toBeInTheDocument()
  })

  it("refreshes while open when a template is saved or deleted", async () => {
    const { ctx, store } = makeHarness({ "template:old": "x" })
    const Panel = createTemplatesPanel(ctx, store)
    render(<Panel {...renderProps} />)
    expect(await screen.findByText("old")).toBeInTheDocument()

    await act(async () => {
      await store.save("fresh", "y")
    })
    expect(await screen.findByText("fresh")).toBeInTheDocument()

    await act(async () => {
      await store.remove("old")
    })
    await waitFor(() => expect(screen.queryByText("old")).toBeNull())
  })
})
