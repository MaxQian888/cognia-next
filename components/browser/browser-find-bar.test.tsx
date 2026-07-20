import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { BrowserFindBar } from "./browser-find-bar"

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
