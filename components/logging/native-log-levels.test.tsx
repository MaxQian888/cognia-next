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

  it("applies rules through setTracingLevels", async () => {
    render(<NativeLogLevels />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply/i }))
    })
    expect(mockSet).toHaveBeenCalledWith([{ target: "connectors", level: "debug" }], "info")
  })

  it("removes a native rule", async () => {
    render(<NativeLogLevels />)
    expect(await screen.findByText("connectors")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Remove connectors override/i }))
    expect(screen.queryByText("connectors")).not.toBeInTheDocument()
  })
})
