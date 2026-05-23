/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import "fake-indexeddb/auto"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Control the orchestrator: publishEntry succeeds or throws a PII error.
const mockPublishEntry = jest.fn()
jest.mock("@/lib/ai/agent/team/shared-memory-orchestrator", () => {
  class SharedMemoryPiiError extends Error {
    constructor(public readonly key: string) {
      super("pii")
      this.name = "SharedMemoryPiiError"
    }
  }
  return {
    publishEntry: (...args: unknown[]) => mockPublishEntry(...args),
    SharedMemoryPiiError,
    OPERATOR_READER_ID: "operator",
  }
})

jest.mock("./settings-save-indicator", () => ({ markSettingsSaved: jest.fn() }))

import { MemoryComposer } from "./memory-composer"
import { SharedMemoryPiiError } from "@/lib/ai/agent/team/shared-memory-orchestrator"
import type { AgentTeam } from "@/types/agent/agent-team"

const team = { id: "team-1", teammateIds: [] } as unknown as AgentTeam

describe("MemoryComposer", () => {
  beforeEach(() => mockPublishEntry.mockReset())

  it("publishes a plain string entry on submit", () => {
    render(<MemoryComposer open onOpenChange={jest.fn()} team={team} mode="create" />)
    fireEvent.change(screen.getByTestId("memory-key"), { target: { value: "note" } })
    fireEvent.change(screen.getByTestId("memory-value"), { target: { value: "hello" } })
    fireEvent.click(screen.getByText("submit"))
    expect(mockPublishEntry).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", key: "note", value: "hello" })
    )
  })

  it("parses JSON when the JSON toggle is on", () => {
    render(<MemoryComposer open onOpenChange={jest.fn()} team={team} mode="create" />)
    fireEvent.change(screen.getByTestId("memory-key"), { target: { value: "obj" } })
    // turn on JSON parse
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.change(screen.getByTestId("memory-value"), { target: { value: '{"a":1}' } })
    fireEvent.click(screen.getByText("submit"))
    expect(mockPublishEntry).toHaveBeenCalledWith(expect.objectContaining({ value: { a: 1 } }))
  })

  it("blocks submit and shows an error on invalid JSON", () => {
    render(<MemoryComposer open onOpenChange={jest.fn()} team={team} mode="create" />)
    fireEvent.change(screen.getByTestId("memory-key"), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.change(screen.getByTestId("memory-value"), { target: { value: "{not json" } })
    fireEvent.click(screen.getByText("submit"))
    expect(mockPublishEntry).not.toHaveBeenCalled()
    expect(screen.getAllByText("invalidJson").length).toBeGreaterThan(0)
  })

  it("surfaces a PII rejection without closing the dialog", () => {
    mockPublishEntry.mockImplementation(() => {
      throw new SharedMemoryPiiError("note")
    })
    const onOpenChange = jest.fn()
    render(<MemoryComposer open onOpenChange={onOpenChange} team={team} mode="create" />)
    fireEvent.change(screen.getByTestId("memory-key"), { target: { value: "note" } })
    fireEvent.change(screen.getByTestId("memory-value"), { target: { value: "leak" } })
    fireEvent.click(screen.getByText("submit"))
    expect(screen.getByText("piiBlocked")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
