import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { BrowserFindBar, BrowserFindBarSection, isFindShortcut } from "./browser-find-bar"

const renderBar = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)
const input = () => screen.getByPlaceholderText("Find in page")

describe("BrowserFindBar", () => {
  it("searches as you type and shows the match counter", async () => {
    const onSearch = jest.fn().mockResolvedValue({ matches: 3, index: 0 })
    renderBar(<BrowserFindBar onSearch={onSearch} onClose={jest.fn()} />)
    fireEvent.change(input(), { target: { value: "abc" } })
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("abc", { forward: true }))
    expect(await screen.findByText("1/3")).toBeInTheDocument()
  })

  it("advances with Enter and rewinds with Shift+Enter", async () => {
    const onSearch = jest.fn().mockResolvedValue({ matches: 2, index: 1 })
    renderBar(<BrowserFindBar onSearch={onSearch} onClose={jest.fn()} />)
    fireEvent.change(input(), { target: { value: "x" } })
    await waitFor(() => expect(onSearch).toHaveBeenCalled())
    fireEvent.keyDown(input(), { key: "Enter" })
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("x", { forward: true }))
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("x", { forward: false }))
  })

  it("steps through matches with the prev/next buttons", async () => {
    const onSearch = jest.fn().mockResolvedValue({ matches: 4, index: 0 })
    renderBar(<BrowserFindBar onSearch={onSearch} onClose={jest.fn()} />)
    fireEvent.change(input(), { target: { value: "y" } })
    await waitFor(() => expect(screen.getByText("1/4")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Next match" }))
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("y", { forward: true }))
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }))
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("y", { forward: false }))
  })

  it("shows no-matches and disables stepping when nothing matches", async () => {
    const onSearch = jest.fn().mockResolvedValue({ matches: 0, index: 0 })
    renderBar(<BrowserFindBar onSearch={onSearch} onClose={jest.fn()} />)
    fireEvent.change(input(), { target: { value: "zzz" } })
    expect(await screen.findByText("No matches")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled()
  })

  it("degrades to no-matches when a later search rejects", async () => {
    const onSearch = jest
      .fn()
      .mockResolvedValueOnce({ matches: 3, index: 0 })
      .mockRejectedValueOnce(new Error("preview gone"))
    renderBar(<BrowserFindBar onSearch={onSearch} onClose={jest.fn()} />)
    fireEvent.change(input(), { target: { value: "ab" } })
    expect(await screen.findByText("1/3")).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: "abc" } })
    expect(await screen.findByText("No matches")).toBeInTheDocument()
  })

  it("closes on Escape and on the close button", () => {
    const onClose = jest.fn()
    renderBar(
      <BrowserFindBar
        onSearch={jest.fn().mockResolvedValue({ matches: 0, index: 0 })}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(input(), { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Close find" }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe("isFindShortcut", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, key: "f" }
  it("matches Cmd/Ctrl+F in either case", () => {
    expect(isFindShortcut({ ...base, metaKey: true })).toBe(true)
    expect(isFindShortcut({ ...base, ctrlKey: true, key: "F" })).toBe(true)
  })
  it("rejects plain F, Alt-modified, and other keys", () => {
    expect(isFindShortcut(base)).toBe(false)
    expect(isFindShortcut({ ...base, metaKey: true, altKey: true })).toBe(false)
    expect(isFindShortcut({ ...base, ctrlKey: true, key: "g" })).toBe(false)
  })
})

describe("BrowserFindBarSection", () => {
  it("renders the find bar inside its standard row", () => {
    renderBar(
      <BrowserFindBarSection
        onSearch={jest.fn().mockResolvedValue({ matches: 0, index: 0 })}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("browser-find-bar")).toBeInTheDocument()
  })
})
