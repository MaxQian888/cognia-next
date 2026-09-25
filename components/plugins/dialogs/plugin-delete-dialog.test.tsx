/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

import { PluginDeleteDialog } from "./plugin-delete-dialog"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("PluginDeleteDialog", () => {
  it("renders title and body when open", () => {
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("body:Alpha")).toBeInTheDocument()
  })

  it("renders the confirm action with the destructive variant", () => {
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole("button", { name: "confirm" })).toHaveAttribute(
      "data-variant",
      "destructive"
    )
  })

  it("confirm calls onConfirm once and never onCancel", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={onCancel} onConfirm={onConfirm} />)
    await user.click(screen.getByRole("button", { name: "confirm" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ cascade: false })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("toggling cascade and confirming passes cascade=true", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={onConfirm} />)
    await user.click(screen.getByLabelText(/cascadeLabel/))
    await user.click(screen.getByRole("button", { name: "confirm" }))
    expect(onConfirm).toHaveBeenCalledWith({ cascade: true })
  })

  it("cancel calls onCancel exactly once", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={onCancel} onConfirm={() => {}} />)
    await user.click(screen.getByRole("button", { name: "cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("Escape calls onCancel exactly once", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={onCancel} onConfirm={() => {}} />)
    await user.keyboard("{Escape}")
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("locks the dialog while the uninstall is in flight", async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const onCancel = jest.fn()
    render(
      <PluginDeleteDialog
        open
        pluginName="Alpha"
        onCancel={onCancel}
        onConfirm={() => gate.promise}
      />
    )
    await user.click(screen.getByRole("button", { name: "confirm" }))
    expect(screen.getByRole("button", { name: "confirming" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "cancel" })).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(screen.getByRole("button", { name: "confirm" })).not.toBeDisabled()
  })
})
