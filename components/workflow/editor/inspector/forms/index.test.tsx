/**
 * @jest-environment jsdom
 *
 * Focused coverage for the forms newly added/changed in the node-config
 * completeness work: the two synthesizer-internal team forms and the desktop
 * event trigger. (The bulk of the pre-existing forms are exercised via the
 * desktop shells + integration; this file guards the new additions.)
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  TeamTriggerConfig,
  TeamTaskDispatchConfig,
  DesktopEventTriggerConfig,
  GoalCompletedTriggerConfig,
} from "./index"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({
  listTeams: jest.fn(async () => [{ id: "team_1", name: "Alpha" }]),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
        none: "None",
      },
      teamTrigger: { intro: "Fired internally by the agent-team runtime." },
      teamTaskDispatch: {
        teamId: { label: "Team" },
        taskId: { label: "Task id", hint: "Stable id", placeholder: "task_" },
        title: { label: "Title", placeholder: "Title" },
        description: { label: "Description", placeholder: "Detail" },
        expectedOutput: { label: "Expected output", hint: "Used to validate" },
      },
      desktopEventTrigger: {
        desktopOnly: "Desktop only.",
        kinds: {
          label: "Event kinds",
          hint: "Fire on UIA events.",
          options: {
            "focus-changed": "Focus changed",
            "structure-changed": "Structure changed",
            "property-changed": "Property changed",
          },
        },
      },
      goalCompletedTrigger: {
        goalId: { label: "Goal id (optional)", hint: "Limit to a specific goal." },
        status: {
          label: "Terminal status (optional)",
          hint: "Limit to one outcome.",
          placeholder: "completed",
        },
        sessionId: { label: "Session id (optional)", hint: "Limit to a chat session." },
        characterId: { label: "Character (optional)" },
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("TeamTriggerConfig", () => {
  it("renders the informational intro", () => {
    wrap(<TeamTriggerConfig />)
    expect(screen.getByText(/agent-team runtime/i)).toBeInTheDocument()
  })
})

describe("TeamTaskDispatchConfig", () => {
  it("renders the dispatch fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<TeamTaskDispatchConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Task id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Task id/i), { target: { value: "task_42" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_42" }))
  })
})

describe("DesktopEventTriggerConfig", () => {
  it("toggles event kinds into params.kinds", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["focus-changed"] }))
  })

  it("removes a kind when toggled off", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{ kinds: ["focus-changed"] }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: [] }))
  })
})

describe("GoalCompletedTriggerConfig", () => {
  it("renders the optional scope fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Goal id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Terminal status/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Goal id/i), { target: { value: "goal_7" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_7" }))
  })

  it("reflects existing params into the inputs", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{ status: "stopped" }} onChange={onChange} />)
    expect(screen.getByLabelText(/Terminal status/i)).toHaveValue("stopped")
  })
})
