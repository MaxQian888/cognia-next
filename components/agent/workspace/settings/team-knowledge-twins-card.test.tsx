/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    try {
      return fn()
    } catch {
      return undefined
    }
  },
}))

const listTwinsMock = jest.fn()
jest.mock("@/lib/db/twins", () => ({
  listTwins: (...args: unknown[]) => listTwinsMock(...args),
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

import { TeamKnowledgeTwinsCard } from "./team-knowledge-twins-card"
import type { AgentTeam } from "@/types/agent/agent-team"

const TWINS = [
  { id: "tw1", name: "Alice", createdAt: 0, updatedAt: 0 },
  { id: "tw2", name: "Bob", createdAt: 0, updatedAt: 0 },
]

function makeTeam(knowledgeTwinIds?: string[]): AgentTeam {
  return {
    id: "t1",
    name: "Team",
    description: "",
    task: "task",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      knowledgeTwinIds,
    },
    leadId: "lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  } as AgentTeam
}

beforeEach(() => {
  updateTeamConfigMock.mockReset()
  listTwinsMock.mockReset()
  listTwinsMock.mockReturnValue(TWINS)
})

describe("TeamKnowledgeTwinsCard", () => {
  it("renders the title and hint", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam()} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("hint")).toBeInTheDocument()
  })

  it("renders a chip per live twin", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam()} />)
    expect(screen.getByTestId("knowledge-twin-tw1")).toHaveTextContent("Alice")
    expect(screen.getByTestId("knowledge-twin-tw2")).toHaveTextContent("Bob")
  })

  it("reflects team.config.knowledgeTwinIds via aria-pressed", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam(["tw2"])} />)
    expect(screen.getByTestId("knowledge-twin-tw1")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("knowledge-twin-tw2")).toHaveAttribute("aria-pressed", "true")
  })

  it("toggling an unselected twin adds its id to knowledgeTwinIds", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam(["tw1"])} />)
    fireEvent.click(screen.getByTestId("knowledge-twin-tw2"))
    expect(updateTeamConfigMock).toHaveBeenCalledTimes(1)
    const [teamId, config] = updateTeamConfigMock.mock.calls[0]
    expect(teamId).toBe("t1")
    expect(new Set(config.knowledgeTwinIds)).toEqual(new Set(["tw1", "tw2"]))
  })

  it("toggling the last selected twin off clears knowledgeTwinIds to undefined", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam(["tw1"])} />)
    fireEvent.click(screen.getByTestId("knowledge-twin-tw1"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ knowledgeTwinIds: undefined })
    )
  })

  it("toggling one of several selected twins off keeps the remaining ids", () => {
    render(<TeamKnowledgeTwinsCard team={makeTeam(["tw1", "tw2"])} />)
    fireEvent.click(screen.getByTestId("knowledge-twin-tw1"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ knowledgeTwinIds: ["tw2"] })
    )
  })

  it("renders the empty state when there are no twins", () => {
    listTwinsMock.mockReturnValue([])
    render(<TeamKnowledgeTwinsCard team={makeTeam()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-twin-tw1")).not.toBeInTheDocument()
  })

  it("falls back to an empty twin list when the live query has not resolved yet", () => {
    listTwinsMock.mockImplementation(() => {
      throw new Error("not ready")
    })
    expect(() => render(<TeamKnowledgeTwinsCard team={makeTeam()} />)).not.toThrow()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
