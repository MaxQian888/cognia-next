import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import type { TrayPanelAction } from "@/lib/tray-panel/types"

import { TrayPanelActionEditor, blankAction, effectOfKind } from "./tray-panel-action-editor"

const valid: TrayPanelAction = {
  id: "custom.1",
  label: "Summarise",
  fields: [{ kind: "text", id: "url", label: "URL" }],
  trigger: { kind: "manual" },
  effect: { kind: "slash", command: "summarise {{url}}" },
}

function renderEditor(
  action: TrayPanelAction = valid,
  onSave = jest.fn(),
  onOpenChange = jest.fn()
) {
  render(<TrayPanelActionEditor open onOpenChange={onOpenChange} action={action} onSave={onSave} />)
  return { onSave, onOpenChange }
}

describe("blankAction / effectOfKind", () => {
  it("starts a new action as a manual delegate", () => {
    const a = blankAction("custom.new")
    expect(a).toMatchObject({
      id: "custom.new",
      label: "",
      fields: [],
      trigger: { kind: "manual" },
      effect: { kind: "delegate", target: "newSession", autoSend: true },
    })
  })

  it("seeds the required members of every effect kind", () => {
    expect(effectOfKind("delegate")).toEqual({
      kind: "delegate",
      prompt: "",
      target: "newSession",
      autoSend: true,
    })
    expect(effectOfKind("slash")).toEqual({ kind: "slash", command: "" })
    expect(effectOfKind("command")).toEqual({ kind: "command", commandId: "" })
    expect(effectOfKind("navigate")).toEqual({ kind: "navigate", path: "/" })
    expect(effectOfKind("native")).toEqual({ kind: "native", action: "show" })
  })
})

describe("TrayPanelActionEditor", () => {
  it("saves the edited draft and closes", async () => {
    const user = userEvent.setup()
    const { onSave, onOpenChange } = renderEditor()

    fireEvent.change(screen.getByLabelText("label", { selector: "#tp-label" }), {
      target: { value: "Renamed" },
    })
    await user.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ label: "Renamed" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("cancels without saving", async () => {
    const user = userEvent.setup()
    const { onSave, onOpenChange } = renderEditor()

    await user.click(screen.getByRole("button", { name: "cancel" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("blocks saving an action with no label", () => {
    renderEditor({ ...valid, label: "" })
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
    expect(screen.getByText("issues.missingLabel")).toBeInTheDocument()
  })

  it("blocks saving when a placeholder names no field", () => {
    renderEditor({ ...valid, effect: { kind: "slash", command: "go {{missing}}" } })
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
    expect(screen.getByText(/issues.unknownPlaceholder/)).toBeInTheDocument()
  })

  it("blocks a delegate that would fire on every panel open", async () => {
    const user = userEvent.setup()
    renderEditor({
      ...valid,
      fields: [],
      effect: { kind: "delegate", prompt: "go", target: "newSession", autoSend: true },
    })

    await user.click(screen.getByRole("combobox", { name: "trigger" }))
    await user.click(await screen.findByRole("option", { name: "triggers.open" }))

    expect(screen.getByText("issues.illegalTrigger")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
  })

  it("reveals the chord input only for a shortcut trigger", async () => {
    const user = userEvent.setup()
    renderEditor()
    expect(screen.queryByLabelText("chord")).not.toBeInTheDocument()

    await user.click(screen.getByRole("combobox", { name: "trigger" }))
    await user.click(await screen.findByRole("option", { name: "triggers.hotkey" }))

    expect(screen.getByLabelText("chord")).toHaveValue("mod+1")
  })

  it("swaps the effect's inputs when its kind changes", async () => {
    const user = userEvent.setup()
    renderEditor()
    expect(screen.getByLabelText("slash")).toBeInTheDocument()

    await user.click(screen.getByRole("combobox", { name: "effect" }))
    await user.click(await screen.findByRole("option", { name: "effects.navigate" }))

    expect(screen.queryByLabelText("slash")).not.toBeInTheDocument()
    expect(screen.getByLabelText("path")).toHaveValue("/")
  })

  it("offers only the whitelisted native actions", async () => {
    const user = userEvent.setup()
    renderEditor({ ...valid, fields: [], effect: { kind: "native", action: "show" } })

    await user.click(screen.getByRole("combobox", { name: "nativeAction" }))
    expect(await screen.findByRole("option", { name: "tray-panel-toggle" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "quit" })).toBeInTheDocument()
  })

  it("drops the i18n key when a built-in is relabelled", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor({ ...valid, labelKey: "trayPanel.actions.openApp.label" })

    fireEvent.change(screen.getByLabelText("label", { selector: "#tp-label" }), {
      target: { value: "Mine" },
    })
    await user.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Mine", labelKey: undefined })
    )
  })

  it("edits the delegate destination, including a field reference", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor({
      ...valid,
      fields: [{ kind: "text", id: "dest", label: "Dest" }],
      effect: { kind: "delegate", prompt: "go", target: "newSession", autoSend: true },
    })

    fireEvent.change(screen.getByLabelText("target"), { target: { value: "{{dest}}" } })
    await user.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ effect: expect.objectContaining({ target: "{{dest}}" }) })
    )
  })

  it("carries a field added in the editor into the saved action", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor({
      ...valid,
      fields: [],
      effect: { kind: "slash", command: "go" },
    })

    await user.click(screen.getByRole("button", { name: "add" }))
    await user.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ fields: [expect.objectContaining({ kind: "text" })] })
    )
  })
})
