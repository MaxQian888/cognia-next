import React, { useReducer } from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { Input } from "./Input"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { DirEntry, ListDir } from "../commands/file-completer"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const listing: Record<string, DirEntry[]> = {
  ".": [
    { name: "src", isDir: true },
    { name: "readme.md", isDir: false },
  ],
}
const listDir: ListDir = (dir) => listing[dir] ?? []

function Harness({
  onSubmit,
  disabled,
  listDir: listDirProp,
}: {
  onSubmit: (t: string) => void
  disabled?: boolean
  listDir?: ListDir
}) {
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => createInitialState(config, "s"))
  return (
    <Input
      input={state.input}
      dispatch={dispatch}
      onSubmit={onSubmit}
      disabled={disabled}
      cwd="/work"
      listDir={listDirProp ?? listDir}
    />
  )
}

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}
function type(text: string) {
  for (const ch of text) key(ch)
}

describe("Input (rich composer)", () => {
  beforeEach(() => __resetInk())

  it("types and submits a line", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("hello")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("inserts a newline on Shift+Enter and submits multiline", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("a")
    key("", { return: true, shift: true })
    type("b")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("a\nb")
  })

  it("backspaces characters", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("ax")
    key("", { backspace: true })
    type("b")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("ab")
  })

  it("shows the slash palette and accepts a command", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/mo")
    expect(container.textContent).toContain("/model")
    expect(container.textContent).toContain("/mode")
    key("", { downArrow: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("/mode")
  })

  it("dismisses the slash palette on Escape", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/mo")
    expect(container.textContent).toContain("/model")
    key("", { escape: true })
    expect(container.textContent).not.toContain("— switch the model")
  })

  it("completes an @ file path", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@s")
    expect(container.textContent).toContain("@src/")
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@src/")
  })

  it("drills into a folder: accepting a dir keeps the popup open for its contents", () => {
    const onSubmit = jest.fn()
    const nested: Record<string, DirEntry[]> = {
      ".": [{ name: "src", isDir: true }],
      src: [
        { name: "App.tsx", isDir: false },
        { name: "tui", isDir: true },
      ],
    }
    const { container } = render(
      <Harness onSubmit={onSubmit} listDir={(dir) => nested[dir] ?? []} />
    )
    type("@s")
    expect(container.textContent).toContain("@src/")
    // Accept the directory — no trailing space, popup re-derives for `src/`.
    key("", { tab: true })
    expect(container.textContent).toContain("@src/App.tsx")
    expect(container.textContent).toContain("@src/tui/")
    // Contents sort dirs-first (tui/ at 0, App.tsx at 1); step down to the file,
    // accept it — terminal, so a trailing space closes the popup — then submit.
    key("", { downArrow: true })
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@src/App.tsx")
  })

  it("recalls history with the up arrow", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("first")
    key("", { return: true })
    key("", { upArrow: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenNthCalledWith(2, "first")
  })

  it("collapses a large paste and expands it on submit", () => {
    const onSubmit = jest.fn()
    const big = "l1\nl2\nl3\nl4\nl5\nl6"
    const { container } = render(<Harness onSubmit={onSubmit} />)
    key(big)
    expect(container.textContent).toContain("[Pasted 6 lines")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith(big)
  })

  it("boosts recently used slash commands to the top of the palette", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/model")
    key("", { return: true })
    // Open the palette again and explicitly select /mode (not /model) so the
    // second submission is recorded as a distinct, more recent command.
    type("/mo")
    key("", { downArrow: true })
    key("", { return: true })
    type("/")
    // The palette lists all commands; /mode was used most recently, so it sorts
    // before /model even though /model is registered first.
    const text = container.textContent ?? ""
    const modeIdx = text.indexOf("/mode —")
    const modelIdx = text.indexOf("/model —")
    expect(modeIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(-1)
    expect(modeIdx).toBeLessThan(modelIdx)
  })

  it("does not handle keys when disabled", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} disabled />)
    type("hi")
    key("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
