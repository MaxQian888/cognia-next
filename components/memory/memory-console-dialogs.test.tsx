/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import type { MemoryConsoleState } from "@/hooks/memory/use-memory-console"

jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => [] }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: async () => [] }))
jest.mock("@/hooks/memory/use-memory-command", () => ({
  useMemoryCommand: () => ({ run: jest.fn(), authority: "local" }),
}))

import { MemoryConsoleDialogs } from "./memory-console-dialogs"

function state(over: Partial<MemoryConsoleState> = {}): MemoryConsoleState {
  return {
    addOpen: false,
    setAddOpen: jest.fn(),
    create: jest.fn(),
    moveMemory: undefined,
    setMoveId: jest.fn(),
    relocate: jest.fn(),
    selectedMemory: undefined,
    conflictPartner: undefined,
    resolverOpen: false,
    setResolverOpen: jest.fn(),
    resolveMemory: () => undefined,
    open: jest.fn(),
    pendingDelete: null,
    setPendingDelete: jest.fn(),
    confirmDelete: jest.fn(),
    ...over,
  } as unknown as MemoryConsoleState
}

describe("MemoryConsoleDialogs", () => {
  it("mounts nothing visible while every dialog is closed", () => {
    render(<MemoryConsoleDialogs state={state()} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("opens the add dialog from state", () => {
    render(<MemoryConsoleDialogs state={state({ addOpen: true })} />)
    expect(screen.getByRole("dialog", { name: "Add memory" })).toBeInTheDocument()
  })

  it("opens the one delete confirmation for pending ids", () => {
    render(<MemoryConsoleDialogs state={state({ pendingDelete: ["a", "b"] })} />)
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 2 memories?")
  })
})
