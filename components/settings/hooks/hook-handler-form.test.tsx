/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { HookHandler } from "@/lib/claude/hooks"
import { HookHandlerForm } from "./hook-handler-form"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("HookHandlerForm", () => {
  it("renders command variant by default with type pill and command textarea", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "echo hi" }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    const root = screen.getByTestId("hook-handler-form")
    expect(root.dataset.handlerType).toBe("command")
    expect((screen.getByTestId("handler-command") as HTMLTextAreaElement).value).toBe("echo hi")
  })

  it("switching type from command to webhook resets fields to webhook defaults", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "x" }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    // Use the underlying hidden select element exposed by data-testid.
    const hiddenSelect = screen
      .getByTestId("handler-type-select")
      .closest("div")!
      .querySelector("button")!
    fireEvent.click(hiddenSelect)
    // Radix select renders options to a portal; click the webhook option.
    fireEvent.click(screen.getByText("typeWebhook"))
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "",
      headers: {},
      timeout: undefined,
    })
  })

  it("typing into command textarea emits an updated handler", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "" }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-command"), { target: { value: "ls -la" } })
    expect(onChange).toHaveBeenCalledWith({ type: "command", command: "ls -la" })
  })

  it("renders webhook variant with URL field and headers editor", () => {
    const onChange = jest.fn()
    const value: HookHandler = {
      type: "webhook",
      url: "https://example.com/hook",
      headers: { "X-Token": "secret" },
    }
    render(<HookHandlerForm value={value} onChange={onChange} onRemove={() => undefined} />)
    expect((screen.getByTestId("handler-url") as HTMLInputElement).value).toBe(
      "https://example.com/hook"
    )
    const keys = screen.getAllByTestId("handler-header-key")
    expect((keys[0] as HTMLInputElement).value).toBe("X-Token")
  })

  it("URL change emits the new url, preserving headers and timeout", () => {
    const onChange = jest.fn()
    const value: HookHandler = {
      type: "webhook",
      url: "",
      headers: { A: "1" },
      timeout: 5,
    }
    render(<HookHandlerForm value={value} onChange={onChange} onRemove={() => undefined} />)
    fireEvent.change(screen.getByTestId("handler-url"), {
      target: { value: "https://hooks.test" },
    })
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "https://hooks.test",
      headers: { A: "1" },
      timeout: 5,
    })
  })

  it("adding a header row expands the headers map with an empty key", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "", headers: {} }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.click(screen.getByTestId("handler-headers-add"))
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "",
      headers: { "": "" },
    })
  })

  it("editing a header key migrates the entry under the new key (preserving order)", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "", headers: { Old: "v" } }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-header-key"), { target: { value: "New" } })
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "",
      headers: { New: "v" },
    })
  })

  it("editing a header value updates only the value", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "", headers: { K: "old" } }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-header-value"), { target: { value: "new" } })
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "",
      headers: { K: "new" },
    })
  })

  it("removing a header drops the entry", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "", headers: { K: "v", Other: "z" } }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.click(screen.getAllByTestId("handler-header-remove")[0])
    expect(onChange).toHaveBeenCalledWith({
      type: "webhook",
      url: "",
      headers: { Other: "z" },
    })
  })

  it("typing a non-numeric timeout falls back to undefined", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "x", timeout: 10 }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-timeout"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith({ type: "command", command: "x", timeout: undefined })
  })

  it("typing a numeric timeout emits the parsed number", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "x" }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-timeout"), { target: { value: "42" } })
    expect(onChange).toHaveBeenCalledWith({ type: "command", command: "x", timeout: 42 })
  })

  it("clicking Remove notifies the parent", () => {
    const onRemove = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "command", command: "x" }}
        onChange={() => undefined}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByTestId("handler-remove"))
    expect(onRemove).toHaveBeenCalled()
  })

  it("shows headersEmpty placeholder when no headers exist", () => {
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "", headers: {} }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.getByText("headersEmpty")).toBeInTheDocument()
  })
})
