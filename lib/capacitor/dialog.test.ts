/**
 * @jest-environment jsdom
 */
import { alert, confirm, prompt } from "./dialog"

function makeDialog() {
  return {
    alert: jest.fn().mockResolvedValue(undefined),
    confirm: jest.fn().mockResolvedValue({ value: true }),
    prompt: jest.fn().mockResolvedValue({ value: "hello", cancelled: false }),
  }
}

describe("alert", () => {
  it("forwards arguments and returns shown", async () => {
    const dialog = makeDialog()
    const out = await alert({
      title: "Hi",
      message: "Welcome",
      buttonTitle: "OK",
      loader: async () => dialog,
    })
    expect(dialog.alert).toHaveBeenCalledWith({
      title: "Hi",
      message: "Welcome",
      buttonTitle: "OK",
    })
    expect(out).toEqual({ kind: "shown" })
  })

  it("returns unsupported when plugin missing", async () => {
    const out = await alert({
      message: "hi",
      loader: async () => {
        throw new Error("nope")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})

describe("confirm", () => {
  it("returns confirmed for value=true", async () => {
    const dialog = makeDialog()
    dialog.confirm.mockResolvedValue({ value: true })
    const out = await confirm({
      message: "Sure?",
      loader: async () => dialog,
    })
    expect(out).toEqual({ kind: "confirmed" })
  })

  it("returns cancelled for value=false", async () => {
    const dialog = makeDialog()
    dialog.confirm.mockResolvedValue({ value: false })
    const out = await confirm({
      message: "Sure?",
      loader: async () => dialog,
    })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("forwards okText/cancelText as native button titles", async () => {
    const dialog = makeDialog()
    await confirm({
      message: "Delete?",
      okText: "Yes",
      cancelText: "No",
      loader: async () => dialog,
    })
    expect(dialog.confirm).toHaveBeenCalledWith({
      title: undefined,
      message: "Delete?",
      okButtonTitle: "Yes",
      cancelButtonTitle: "No",
    })
  })
})

describe("prompt", () => {
  it("returns submitted with value when not cancelled", async () => {
    const dialog = makeDialog()
    dialog.prompt.mockResolvedValue({ value: "abc", cancelled: false })
    const out = await prompt({
      message: "Enter key:",
      defaultValue: "",
      loader: async () => dialog,
    })
    expect(out).toEqual({ kind: "submitted", value: "abc" })
  })

  it("returns cancelled when cancelled flag true", async () => {
    const dialog = makeDialog()
    dialog.prompt.mockResolvedValue({ value: "", cancelled: true })
    const out = await prompt({
      message: "Enter key:",
      loader: async () => dialog,
    })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("forwards placeholder and defaultValue", async () => {
    const dialog = makeDialog()
    await prompt({
      message: "?",
      defaultValue: "init",
      placeholder: "type here",
      loader: async () => dialog,
    })
    expect(dialog.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ inputText: "init", inputPlaceholder: "type here" })
    )
  })
})
