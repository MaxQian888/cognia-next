/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import "fake-indexeddb/auto"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { MemorySection } from "./section-memory"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, SharedMemoryEntry } from "@/types/agent/agent-team"

const mkEntry = (over: Partial<SharedMemoryEntry>): SharedMemoryEntry => ({
  key: "k",
  value: "v",
  writtenBy: "tm-1",
  writtenAt: new Date(),
  version: 1,
  ...over,
})

describe("MemorySection (operator ACL view)", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
  })

  it("shows every entry regardless of readableBy (operator bypass)", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Mem", task: "t" })
    useAgentTeamStore.setState(() => ({
      sharedMemory: {
        [team.id]: {
          open: mkEntry({ key: "open" }),
          scoped: mkEntry({ key: "scoped", readableBy: ["tm-only"] }),
        },
      },
    }))

    render(<MemorySection team={useAgentTeamStore.getState().teams[team.id] as AgentTeam} />)

    // Operator view: both the open and the ACL-scoped entry are visible.
    expect(screen.getByTestId("memory-row-open")).toBeInTheDocument()
    expect(screen.getByTestId("memory-row-scoped")).toBeInTheDocument()
  })

  it("renders the empty state when the team has no entries", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Empty", task: "t" })
    render(<MemorySection team={useAgentTeamStore.getState().teams[team.id] as AgentTeam} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
