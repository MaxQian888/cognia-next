/**
 * Tests for `PluginDataDialog` — the host-rendered, data-driven dialog backing
 * `ctx.ui.showDialog` / `showInputDialog` / `showConfirmDialog`. Verifies each
 * dialog kind settles its caller promise on action and on dismiss (unmount).
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { PluginDataDialog, type PluginDataDialogArgs } from "./plugin-data-dialog"

function renderDialog(args: PluginDataDialogArgs, onClose = jest.fn()) {
  // Mirror the real mount: the modal root wraps each entry in Dialog/DialogContent.
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Dialog open>
        <DialogContent>
          <PluginDataDialog modalId="m1" args={args} onClose={onClose} />
        </DialogContent>
      </Dialog>
    </NextIntlClientProvider>
  )
  return { ...utils, onClose }
}

describe("PluginDataDialog", () => {
  describe("confirm", () => {
    it("settles true and closes on confirm", () => {
      const settle = jest.fn()
      const { onClose } = renderDialog({
        kind: "confirm",
        options: { title: "Delete?", message: "This cannot be undone." },
        settle,
      })
      expect(screen.getByText("This cannot be undone.")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
      expect(settle).toHaveBeenCalledWith(true)
      expect(onClose).toHaveBeenCalled()
    })

    it("settles false on cancel", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "confirm",
        options: { title: "Delete?", message: "Sure?" },
        settle,
      })
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      expect(settle).toHaveBeenCalledWith(false)
    })

    it("honors custom confirm/cancel labels", () => {
      renderDialog({
        kind: "confirm",
        options: { title: "t", message: "m", confirmLabel: "Yes go", cancelLabel: "No stop" },
        settle: jest.fn(),
      })
      expect(screen.getByRole("button", { name: "Yes go" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "No stop" })).toBeInTheDocument()
    })
  })

  describe("input", () => {
    it("settles the typed value on confirm", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "input",
        options: { title: "Name", defaultValue: "ada" },
        settle,
      })
      const input = screen.getByRole("textbox")
      fireEvent.change(input, { target: { value: "grace" } })
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
      expect(settle).toHaveBeenCalledWith("grace")
    })

    it("blocks submit and shows the validation error", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "input",
        options: { title: "Port", validate: (v) => (v === "x" ? "bad value" : null) },
        settle,
      })
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
      expect(screen.getByText("bad value")).toBeInTheDocument()
      expect(settle).not.toHaveBeenCalled()
    })

    it("settles null on cancel", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "input",
        options: { title: "Name" },
        settle,
      })
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      expect(settle).toHaveBeenCalledWith(null)
    })

    it("submits on Enter", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "input",
        options: { title: "Name", defaultValue: "z" },
        settle,
      })
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
      expect(settle).toHaveBeenCalledWith("z")
    })
  })

  describe("dialog (actions)", () => {
    it("settles the chosen action value", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "dialog",
        options: {
          title: "Pick",
          content: "body",
          actions: [
            { label: "Save", value: "save" },
            { label: "Discard", value: "discard", variant: "destructive" },
          ],
        },
        settle,
      })
      fireEvent.click(screen.getByRole("button", { name: "Discard" }))
      expect(settle).toHaveBeenCalledWith("discard")
    })

    it("shows a single confirm button when there are no actions", () => {
      const settle = jest.fn()
      renderDialog({
        kind: "dialog",
        options: { title: "Notice", content: "hi" },
        settle,
      })
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
      expect(settle).toHaveBeenCalledWith(undefined)
    })
  })

  describe("dismiss", () => {
    it("settles the dismiss default when unmounted without an action", () => {
      const settle = jest.fn()
      const { unmount } = renderDialog({
        kind: "confirm",
        options: { title: "t", message: "m" },
        settle,
      })
      unmount()
      expect(settle).toHaveBeenCalledWith(false)
    })

    it("does not double-settle when an action ran before unmount", () => {
      const settle = jest.fn()
      const { unmount } = renderDialog({
        kind: "input",
        options: { title: "Name", defaultValue: "v" },
        settle,
      })
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
      unmount()
      expect(settle).toHaveBeenCalledTimes(1)
      expect(settle).toHaveBeenCalledWith("v")
    })
  })
})
