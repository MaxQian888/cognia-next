import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))

import { sendTrayPanelRequest } from "@/lib/tauri/tray-panel"
import type { TrayPanelAction } from "@/lib/tray-panel/types"

import { TrayPanelDelegateBar, inlineFieldOf } from "./tray-panel-delegate-bar"
import { TrayPanelRunnerProvider, useTrayPanelRunnerState } from "./tray-panel-runner"

const sendMock = sendTrayPanelRequest as jest.Mock

const delegate: TrayPanelAction = {
  id: "delegate",
  label: "Delegate",
  trigger: { kind: "submit" },
  fields: [
    {
      kind: "textarea",
      id: "prompt",
      label: "Task",
      placeholder: "Describe it",
      required: true,
      submitOnEnter: true,
    },
    {
      kind: "select",
      id: "target",
      label: "Send to",
      defaultValue: "newSession",
      options: [
        { value: "newSession", label: "New conversation" },
        { value: "activeSession", label: "Current conversation" },
      ],
    },
    { kind: "switch", id: "autoSend", label: "Send immediately", defaultValue: true },
  ],
  effect: { kind: "delegate", prompt: "{{prompt}}", target: "{{target}}", autoSend: true },
}

const noInline: TrayPanelAction = {
  id: "ping",
  label: "Ping",
  trigger: { kind: "submit" },
  fields: [],
  effect: { kind: "command", commandId: "ping" },
}

function Bar({
  action,
  autoFocus = false,
  revealNonce = 0,
}: {
  action: TrayPanelAction
  autoFocus?: boolean
  revealNonce?: number
}) {
  const runner = useTrayPanelRunnerState([action])
  return (
    <TrayPanelRunnerProvider runner={runner}>
      <TrayPanelDelegateBar action={action} autoFocus={autoFocus} revealNonce={revealNonce} />
    </TrayPanelRunnerProvider>
  )
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(true)
})

describe("inlineFieldOf", () => {
  it("picks the first text-like field", () => {
    expect(inlineFieldOf(delegate)?.id).toBe("prompt")
    const textFirst: TrayPanelAction = {
      ...delegate,
      fields: [delegate.fields[2], { kind: "text", id: "q", label: "Q" }, delegate.fields[0]],
    }
    expect(inlineFieldOf(textFirst)?.id).toBe("q")
  })

  it("is null without one", () => {
    expect(inlineFieldOf(noInline)).toBeNull()
  })
})

describe("TrayPanelDelegateBar", () => {
  it("remeasures wrapped text on width changes without looping on height changes", () => {
    const previousObserver = global.ResizeObserver
    let notify: ResizeObserverCallback | undefined
    const disconnect = jest.fn()
    global.ResizeObserver = jest.fn().mockImplementation((callback: ResizeObserverCallback) => {
      notify = callback
      return { observe: jest.fn(), disconnect }
    })
    const height = jest.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
    height.mockReturnValue(24)
    try {
      const { unmount } = render(<Bar action={delegate} />)
      const box = screen.getByRole("textbox", { name: "Task" })
      expect(box.style.height).toBe("24px")
      const resize = (width: number) =>
        act(() =>
          notify?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
        )
      height.mockReturnValue(64)
      resize(180)
      expect(box.style.height).toBe("64px")
      height.mockReturnValue(160)
      resize(180)
      expect(box.style.height).toBe("64px")
      resize(100)
      expect(box.style.height).toBe("100px")
      height.mockReturnValue(24)
      resize(300)
      expect(box.style.height).toBe("24px")
      unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      height.mockRestore()
      global.ResizeObserver = previousObserver
    }
  })

  it("edits the inline field and keeps send disabled while a required prompt is empty", async () => {
    const user = userEvent.setup()
    render(<Bar action={delegate} />)
    const box = screen.getByRole("textbox", { name: "Task" })
    expect(box).toHaveAttribute("placeholder", "Describe it")
    const send = screen.getByRole("button", { name: "Delegate" })
    expect(send).toBeDisabled()

    await user.type(box, "Fix the build")
    expect(send).toBeEnabled()
  })

  it("sends with the button", async () => {
    const user = userEvent.setup()
    render(<Bar action={delegate} />)
    await user.type(screen.getByRole("textbox", { name: "Task" }), "Fix it")
    await user.click(screen.getByRole("button", { name: "Delegate" }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "delegate",
          effect: expect.objectContaining({ prompt: "Fix it", target: "newSession" }),
        })
      )
    )
  })

  it("sends on Enter but keeps Shift+Enter as a newline", async () => {
    const user = userEvent.setup()
    render(<Bar action={delegate} />)
    const box = screen.getByRole("textbox", { name: "Task" })
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two")
    expect(sendMock).not.toHaveBeenCalled()
    expect(box).toHaveValue("line one\nline two")

    await user.type(box, "{Enter}")
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))
  })

  it("does not send on Enter when the textarea does not submit on Enter", async () => {
    const user = userEvent.setup()
    const multiline: TrayPanelAction = {
      ...delegate,
      fields: [{ kind: "textarea", id: "prompt", label: "Task", required: true }],
    }
    render(<Bar action={multiline} />)
    await user.type(screen.getByRole("textbox", { name: "Task" }), "a{Enter}b")
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("summarises the options on the chip and edits them in the popover", async () => {
    const user = userEvent.setup()
    render(<Bar action={delegate} />)
    const chip = screen.getByRole("button", { name: "Delegate options" })
    expect(chip).toHaveTextContent("→ New conversation")
    expect(chip).toHaveAttribute("title", "New conversation")

    await user.click(chip)
    expect(await screen.findByText("Send to")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Send immediately" })).toBeChecked()
  })

  it("hides the options chip when the action has only the inline field", () => {
    render(<Bar action={{ ...delegate, fields: [delegate.fields[0]] }} />)
    expect(screen.queryByRole("button", { name: "Delegate options" })).not.toBeInTheDocument()
  })

  it("shows the label instead of a textbox when the action has no text field", async () => {
    const user = userEvent.setup()
    render(<Bar action={noInline} />)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    const send = screen.getByRole("button", { name: "Ping" })
    expect(send).toBeEnabled()
    await user.click(send)
    await waitFor(() => expect(sendMock).toHaveBeenCalled())
  })

  it("says why a run was blocked under the bar", async () => {
    const user = userEvent.setup()
    render(
      <Bar
        action={{
          ...delegate,
          fields: [{ ...delegate.fields[0], required: false }, ...delegate.fields.slice(1)],
          effect: { kind: "delegate", prompt: "{{missing}}", target: "newSession", autoSend: true },
        }}
      />
    )
    await user.click(screen.getByRole("button", { name: "Delegate" }))
    expect(await screen.findByText("Unknown placeholder: missing")).toBeInTheDocument()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("focuses the field on reveal only when autofocus is on", () => {
    const { rerender } = render(<Bar action={delegate} autoFocus={false} />)
    expect(screen.getByRole("textbox", { name: "Task" })).not.toHaveFocus()
    rerender(<Bar action={delegate} autoFocus revealNonce={1} />)
    expect(screen.getByRole("textbox", { name: "Task" })).toHaveFocus()
  })

  it("refocuses on every reveal", () => {
    const { rerender } = render(<Bar action={delegate} autoFocus revealNonce={0} />)
    const box = screen.getByRole("textbox", { name: "Task" })
    box.blur()
    rerender(<Bar action={delegate} autoFocus revealNonce={1} />)
    expect(box).toHaveFocus()
  })
})
