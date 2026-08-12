/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { HookHandler } from "@/lib/claude/hooks"
import { emptyHandlerForType, HookHandlerForm, validateHandler } from "./hook-handler-form"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The command field now renders the shared CodeMirror `LightCodeEditor`, which
// needs jsdom DOM-measurement shims to mount. Swap it for a plain textarea that
// honours the same `value` / `onChange(string)` / `data-testid` contract so the
// form's own logic (not CM internals) is what these tests exercise.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    onChange,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    value: string
    onChange: (next: string) => void
    "data-testid"?: string
    "aria-label"?: string
  }) => (
    <textarea
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
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

  it("switching type from command to HTTP creates the canonical handler", () => {
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
    fireEvent.click(screen.getByText("types.http"))
    expect(onChange).toHaveBeenCalledWith({
      type: "http",
      url: "",
      headers: {},
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

  it("shows the HTTP capability note only for outbound HTTP handlers", () => {
    const { rerender } = render(
      <HookHandlerForm
        value={{ type: "command", command: "echo hi" }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.queryByTestId("handler-http-capability")).toBeNull()

    rerender(
      <HookHandlerForm
        value={{ type: "http", url: "https://x.test" }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.getByTestId("handler-http-capability")).toBeInTheDocument()
  })

  it("limits the type selector to runtime-proven handler kinds", () => {
    render(
      <HookHandlerForm
        value={{ type: "command", command: "echo hi" }}
        onChange={() => undefined}
        onRemove={() => undefined}
        supportedHandlerTypes={["command", "http"]}
      />
    )
    fireEvent.click(screen.getByTestId("handler-type-select"))
    expect(screen.getAllByText("types.command")).toHaveLength(2)
    expect(screen.getByText("types.http")).toBeInTheDocument()
    expect(screen.queryByText("types.agent")).toBeNull()
  })

  it("edits MCP tool fields", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "mcp_tool", server: "policy", tool: "check", input: {} }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-tool"), { target: { value: "scan" } })
    expect(onChange).toHaveBeenCalledWith({
      type: "mcp_tool",
      server: "policy",
      tool: "scan",
      input: {},
    })
  })

  it("edits prompt and agent handlers", () => {
    const onChange = jest.fn()
    render(
      <HookHandlerForm
        value={{ type: "agent", prompt: "inspect" }}
        onChange={onChange}
        onRemove={() => undefined}
      />
    )
    fireEvent.change(screen.getByTestId("handler-prompt"), { target: { value: "audit" } })
    expect(onChange).toHaveBeenCalledWith({ type: "agent", prompt: "audit" })
  })

  it("surfaces an inline error for an empty command", () => {
    render(
      <HookHandlerForm
        value={{ type: "command", command: "  " }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.getByTestId("handler-error").textContent).toBe("commandRequired")
  })

  it("surfaces an inline error for a malformed webhook URL", () => {
    render(
      <HookHandlerForm
        value={{ type: "webhook", url: "not a url", headers: {} }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.getByTestId("handler-error").textContent).toBe("urlInvalid")
  })

  it("shows no inline error for a valid command handler", () => {
    render(
      <HookHandlerForm
        value={{ type: "command", command: "echo ok" }}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(screen.queryByTestId("handler-error")).toBeNull()
  })
})

describe("validateHandler", () => {
  it("accepts a non-empty command and rejects a blank one", () => {
    expect(validateHandler({ type: "command", command: "echo hi" })).toBeNull()
    expect(validateHandler({ type: "command", command: "" })).toBe("commandRequired")
    expect(validateHandler({ type: "command", command: "   " })).toBe("commandRequired")
  })

  it("accepts a valid http(s) webhook URL", () => {
    expect(validateHandler({ type: "webhook", url: "https://example.com/hook" })).toBeNull()
    expect(validateHandler({ type: "webhook", url: "http://localhost:3000/x" })).toBeNull()
    expect(validateHandler({ type: "http", url: "https://example.com/hook" })).toBeNull()
  })

  it("rejects an empty URL", () => {
    expect(validateHandler({ type: "webhook", url: "" })).toBe("urlRequired")
    expect(validateHandler({ type: "webhook", url: "   " })).toBe("urlRequired")
  })

  it("rejects a non-parseable or non-http(s) URL", () => {
    expect(validateHandler({ type: "webhook", url: "not a url" })).toBe("urlInvalid")
    expect(validateHandler({ type: "webhook", url: "ftp://example.com" })).toBe("urlInvalid")
  })

  it("validates MCP and model-backed handler requirements", () => {
    expect(validateHandler({ type: "mcp_tool", server: "", tool: "scan" })).toBe("serverRequired")
    expect(validateHandler({ type: "mcp_tool", server: "policy", tool: "" })).toBe("toolRequired")
    expect(validateHandler({ type: "prompt", prompt: "" })).toBe("promptRequired")
    expect(validateHandler({ type: "agent", prompt: "inspect" })).toBeNull()
  })
})

describe("emptyHandlerForType", () => {
  it("creates valid editable shapes for every runtime-proven handler type", () => {
    expect(emptyHandlerForType("command")).toEqual({ type: "command", command: "" })
    expect(emptyHandlerForType("http")).toEqual({ type: "http", url: "", headers: {} })
    expect(emptyHandlerForType("mcp_tool")).toEqual({
      type: "mcp_tool",
      server: "",
      tool: "",
      input: {},
    })
    expect(emptyHandlerForType("prompt")).toEqual({ type: "prompt", prompt: "" })
    expect(emptyHandlerForType("agent")).toEqual({ type: "agent", prompt: "" })
  })
})
