import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import {
  keepOpenWhileNestedDialogFocused,
  useChoiceDialog,
  useConfirmDialog,
  type ChoiceDialogOptions,
  type ConfirmDialogOptions,
} from "./confirm-dialog"

type ConfirmFn = (options: ConfirmDialogOptions) => Promise<boolean>
type ChooseFn = (options: ChoiceDialogOptions) => Promise<string | null>

function ConfirmHarness({ onReady }: { onReady: (confirm: ConfirmFn) => void }) {
  const { confirm, dialog } = useConfirmDialog()
  onReady(confirm)
  return (
    <>
      <button type="button">origin</button>
      {dialog}
    </>
  )
}

function ChoiceHarness({ onReady }: { onReady: (choose: ChooseFn) => void }) {
  const { choose, dialog } = useChoiceDialog()
  onReady(choose)
  return dialog
}

function renderConfirm() {
  let confirm: ConfirmFn = () => Promise.resolve(false)
  const utils = render(<ConfirmHarness onReady={(fn) => (confirm = fn)} />)
  return { ...utils, confirm: (options: ConfirmDialogOptions) => confirm(options) }
}

describe("useConfirmDialog", () => {
  it("resolves true when the action is pressed", async () => {
    const user = userEvent.setup()
    const { confirm } = renderConfirm()
    let answer: Promise<boolean> = Promise.resolve(false)
    act(() => {
      answer = confirm({
        title: "Delete it?",
        description: "Gone for good",
        confirmLabel: "Delete",
      })
    })
    const dialog = await screen.findByRole("alertdialog", { name: "Delete it?" })
    expect(dialog).toHaveAccessibleDescription("Gone for good")
    await user.click(screen.getByRole("button", { name: "Delete" }))
    await expect(answer).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("resolves false on cancel and on Escape, with the common labels by default", async () => {
    const user = userEvent.setup()
    const { confirm } = renderConfirm()
    let first: Promise<boolean> = Promise.resolve(true)
    act(() => {
      first = confirm({ title: "First" })
    })
    await screen.findByRole("alertdialog", { name: "First" })
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await expect(first).resolves.toBe(false)

    let second: Promise<boolean> = Promise.resolve(true)
    act(() => {
      second = confirm({ title: "Second" })
    })
    await screen.findByRole("alertdialog", { name: "Second" })
    await user.keyboard("{Escape}")
    await expect(second).resolves.toBe(false)
  })

  it("answers queued requests one at a time and in order", async () => {
    const user = userEvent.setup()
    const { confirm } = renderConfirm()
    let a: Promise<boolean> = Promise.resolve(false)
    let b: Promise<boolean> = Promise.resolve(true)
    act(() => {
      a = confirm({ title: "Request A", confirmLabel: "Allow" })
      b = confirm({ title: "Request B", confirmLabel: "Allow" })
    })
    await screen.findByRole("alertdialog", { name: "Request A" })
    await user.click(screen.getByRole("button", { name: "Allow" }))
    await expect(a).resolves.toBe(true)
    await screen.findByRole("alertdialog", { name: "Request B" })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await expect(b).resolves.toBe(false)
  })

  it("returns focus to the element focused when the request was made", async () => {
    const user = userEvent.setup()
    const { confirm } = renderConfirm()
    const origin = screen.getByRole("button", { name: "origin" })
    origin.focus()
    let answer: Promise<boolean> = Promise.resolve(true)
    act(() => {
      answer = confirm({ title: "Focus" })
    })
    await screen.findByRole("alertdialog", { name: "Focus" })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await answer
    await waitFor(() => expect(origin).toHaveFocus())
  })

  it("honours an explicit restoreFocus target", async () => {
    const user = userEvent.setup()
    const target = document.createElement("textarea")
    document.body.append(target)
    const { confirm } = renderConfirm()
    let answer: Promise<boolean> = Promise.resolve(true)
    act(() => {
      answer = confirm({ title: "Terminal", restoreFocus: () => target })
    })
    await screen.findByRole("alertdialog", { name: "Terminal" })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await answer
    await waitFor(() => expect(target).toHaveFocus())
    target.remove()
  })

  it("denies pending and late requests once the owner unmounts", async () => {
    const { confirm, unmount } = renderConfirm()
    let pending: Promise<boolean> = Promise.resolve(true)
    act(() => {
      pending = confirm({ title: "Pending" })
    })
    await screen.findByRole("alertdialog", { name: "Pending" })
    unmount()
    await expect(pending).resolves.toBe(false)
    await expect(confirm({ title: "Late" })).resolves.toBe(false)
  })

  it("keeps confirm referentially stable across renders", () => {
    const seen: ConfirmFn[] = []
    function Rerendering() {
      const [, setTick] = useState(0)
      const { confirm, dialog } = useConfirmDialog()
      seen.push(confirm)
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            tick
          </button>
          {dialog}
        </>
      )
    }
    render(<Rerendering />)
    act(() => screen.getByRole("button", { name: "tick" }).click())
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(1)
  })
})

describe("useChoiceDialog", () => {
  function renderChoice() {
    let choose: ChooseFn = () => Promise.resolve(null)
    render(<ChoiceHarness onReady={(fn) => (choose = fn)} />)
    return (options: ChoiceDialogOptions) => choose(options)
  }

  const hosts: ChoiceDialogOptions = {
    title: "Pick a Host",
    fieldLabel: "Replacement Host",
    confirmLabel: "Use Host",
    options: [
      { value: "h1", label: "Studio Mac", description: "h1" },
      { value: "h2", label: "Office PC", description: "h2" },
    ],
  }

  it("returns the preselected default", async () => {
    const user = userEvent.setup()
    const choose = renderChoice()
    let answer: Promise<string | null> = Promise.resolve(null)
    act(() => {
      answer = choose({ ...hosts, defaultValue: "h2" })
    })
    await screen.findByRole("dialog", { name: "Pick a Host" })
    expect(screen.getByRole("combobox", { name: "Replacement Host" })).toHaveTextContent(
      "Office PC"
    )
    await user.click(screen.getByRole("button", { name: "Use Host" }))
    await expect(answer).resolves.toBe("h2")
  })

  it("returns the option picked from the select", async () => {
    const user = userEvent.setup()
    const choose = renderChoice()
    let answer: Promise<string | null> = Promise.resolve(null)
    act(() => {
      answer = choose(hosts)
    })
    await screen.findByRole("dialog", { name: "Pick a Host" })
    await user.click(screen.getByRole("combobox", { name: "Replacement Host" }))
    await user.click(await screen.findByRole("option", { name: /Office PC/ }))
    await user.click(screen.getByRole("button", { name: "Use Host" }))
    await expect(answer).resolves.toBe("h2")
  })

  it("returns null on cancel, and immediately when there is nothing to choose", async () => {
    const user = userEvent.setup()
    const choose = renderChoice()
    let answer: Promise<string | null> = Promise.resolve("x")
    act(() => {
      answer = choose(hosts)
    })
    await screen.findByRole("dialog", { name: "Pick a Host" })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await expect(answer).resolves.toBeNull()
    await expect(choose({ ...hosts, options: [] })).resolves.toBeNull()
  })

  it("ignores a default that is not one of the options", async () => {
    const user = userEvent.setup()
    const choose = renderChoice()
    let answer: Promise<string | null> = Promise.resolve(null)
    act(() => {
      answer = choose({ ...hosts, defaultValue: "forged" })
    })
    await screen.findByRole("dialog", { name: "Pick a Host" })
    await user.click(screen.getByRole("button", { name: "Use Host" }))
    await expect(answer).resolves.toBe("h1")
  })
})

describe("keepOpenWhileNestedDialogFocused", () => {
  function focusEventOn(element: Element) {
    const event = new CustomEvent("focusOutside", { cancelable: true })
    Object.defineProperty(event, "target", { value: element })
    return event
  }

  it.each(['role="dialog"', 'role="alertdialog"', 'data-slot="select-content"'])(
    "keeps the host open when focus moves into an element with %s",
    (attribute) => {
      const host = document.createElement("div")
      host.innerHTML = `<div ${attribute}><button>inside</button></div>`
      const event = focusEventOn(host.querySelector("button")!)
      keepOpenWhileNestedDialogFocused(event)
      expect(event.defaultPrevented).toBe(true)
    }
  )

  it("lets any other outside focus dismiss the host", () => {
    const event = focusEventOn(document.createElement("button"))
    keepOpenWhileNestedDialogFocused(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
