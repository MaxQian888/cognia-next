/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

let isTauriValue = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const mockGet = jest.fn()
const mockSet = jest.fn()
jest.mock("@/lib/native/native-logging", () => ({
  getTracingLevels: (...args: unknown[]) => mockGet(...args),
  setTracingLevels: (...args: unknown[]) => mockSet(...args),
}))

import { NativeLogLevels } from "./native-log-levels"

beforeEach(() => {
  isTauriValue = true
  mockGet.mockReset()
  mockSet.mockReset()
  mockGet.mockResolvedValue({
    active: true,
    defaultLevel: "info",
    rules: [{ target: "connectors", level: "debug" }],
  })
  mockSet.mockResolvedValue({
    active: true,
    defaultLevel: "info",
    rules: [{ target: "connectors", level: "debug" }],
  })
})

describe("NativeLogLevels", () => {
  it("renders nothing when not running under Tauri", () => {
    isTauriValue = false
    const { container } = render(<NativeLogLevels />)
    expect(container).toBeEmptyDOMElement()
  })

  it("loads and displays the current native rules on mount", async () => {
    render(<NativeLogLevels />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(await screen.findByText("connectors")).toBeInTheDocument()
  })

  it("adds a new native rule from the input", async () => {
    render(<NativeLogLevels />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    const input = screen.getByPlaceholderText("network:lark") as HTMLInputElement
    fireEvent.change(input, { target: { value: "automation" } })
    fireEvent.click(screen.getByRole("button", { name: /Add Module/i }))
    expect(screen.getByText("automation")).toBeInTheDocument()
  })

  it("applies the edited rules through setTracingLevels", async () => {
    render(<NativeLogLevels />)
    expect(await screen.findByText("connectors")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("network:lark"), {
      target: { value: "automation" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Add Module/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply/i }))
    })
    expect(mockSet).toHaveBeenCalledWith(
      [
        { target: "connectors", level: "debug" },
        { target: "automation", level: "debug" },
      ],
      "info"
    )
  })

  it("keeps Apply disabled until the levels load, and while nothing changed", async () => {
    let resolve: (value: unknown) => void = () => {}
    mockGet.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<NativeLogLevels />)
    expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent(/loading native levels/i)

    await act(async () => {
      resolve({ active: true, defaultLevel: "info", rules: [] })
    })
    // Loaded but clean: nothing to apply.
    expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled()
  })

  it("shows a load error with a retry, and never offers Apply over placeholder defaults", async () => {
    mockGet.mockResolvedValueOnce(null)
    render(<NativeLogLevels />)
    expect(await screen.findByTestId("native-log-levels-load-error")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Add Module/i })).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Retry/i }))
    })
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(await screen.findByText("connectors")).toBeInTheDocument()
    expect(screen.queryByTestId("native-log-levels-load-error")).not.toBeInTheDocument()
  })

  it("marks the form dirty on edit and clears 'Applied' when the user edits again", async () => {
    render(<NativeLogLevels />)
    expect(await screen.findByText("connectors")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Remove connectors override/i }))
    expect(screen.getByTestId("native-log-levels-dirty")).toBeInTheDocument()
    mockSet.mockResolvedValueOnce({ active: true, defaultLevel: "info", rules: [] })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply/i }))
    })
    expect(screen.getByText("Applied")).toBeInTheDocument()
    expect(screen.queryByTestId("native-log-levels-dirty")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText("network:lark"), {
      target: { value: "automation" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Add Module/i }))
    expect(screen.queryByText("Applied")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Apply/i })).toBeEnabled()
  })

  it("removes a native rule", async () => {
    render(<NativeLogLevels />)
    expect(await screen.findByText("connectors")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Remove connectors override/i }))
    expect(screen.queryByText("connectors")).not.toBeInTheDocument()
  })
})
