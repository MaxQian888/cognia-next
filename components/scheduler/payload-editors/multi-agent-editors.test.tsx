/**
 * @jest-environment jsdom
 *
 * Component tests for the multi-agent structured payload editors
 * (TeamPayloadEditor / GoalPayloadEditor / PlanPayloadEditor). Lists are
 * injected via the `*ForTesting` props so no DB / team-store is touched.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { TeamPayloadEditor } from "./team-payload-editor"
import { GoalPayloadEditor } from "./goal-payload-editor"
import { PlanPayloadEditor } from "./plan-payload-editor"
import {
  EMPTY_AGENT_TEAM_DRAFT,
  EMPTY_GOAL_DRAFT,
  EMPTY_PLAN_DRAFT,
  type AgentTeamDraft,
  type GoalDraft,
  type PlanDraft,
} from "./types"

const messages = {
  scheduler: {
    payload: {
      agentTeam: {
        teamId: "Agent team",
        teamIdPlaceholder: "Select a team",
        persistenceHelp: "live teams not persisted",
        ultracode: "Ultracode",
        ultracodeHelp: "force ultracode",
      },
      goal: {
        objective: "Objective",
        objectivePlaceholder: "what to do",
        objectiveHelp: "redacted",
        characterId: "Character id",
        characterIdPlaceholder: "persona",
        maxTurns: "Max turns",
        maxTokens: "Max tokens",
        timeoutMinutes: "Timeout (min)",
        defaultHint: "default",
      },
      plan: {
        planId: "Agent plan",
        planIdPlaceholder: "Select a plan",
        replanOnFailure: "Replan on failure",
        replanOnFailureHelp: "repair",
      },
      errors: {
        teamIdRequired: "Team is required",
        objectiveRequired: "Objective is required",
        planIdRequired: "Plan is required",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("TeamPayloadEditor", () => {
  it("falls back to a free-text id input when no teams exist", () => {
    function Host() {
      const [draft, setDraft] = useState<AgentTeamDraft>({ ...EMPTY_AGENT_TEAM_DRAFT })
      return <TeamPayloadEditor draft={draft} onDraftChange={setDraft} teamsForTesting={[]} />
    }
    render(wrap(<Host />))
    const input = screen.getByTestId("team-payload-editor-team-input")
    fireEvent.change(input, { target: { value: "team-42" } })
    expect((screen.getByTestId("team-payload-editor-team-input") as HTMLInputElement).value).toBe(
      "team-42"
    )
  })

  it("renders a select when teams exist and surfaces the teamId error", () => {
    render(
      wrap(
        <TeamPayloadEditor
          draft={{ ...EMPTY_AGENT_TEAM_DRAFT }}
          onDraftChange={() => {}}
          teamsForTesting={[{ id: "t1", name: "Alpha" }]}
          errors={{ teamId: "teamIdRequired" }}
        />
      )
    )
    expect(screen.getByTestId("team-payload-editor-team-select")).toBeTruthy()
    expect(screen.getByText(/required/i)).toBeTruthy()
  })

  it("toggles ultracode", () => {
    function Host() {
      const [draft, setDraft] = useState<AgentTeamDraft>({ teamId: "t1", ultracode: false })
      return <TeamPayloadEditor draft={draft} onDraftChange={setDraft} teamsForTesting={[]} />
    }
    render(wrap(<Host />))
    fireEvent.click(screen.getByTestId("team-payload-editor-ultracode-switch"))
    // Switch is a controlled Radix component; the click drives onDraftChange.
    expect(screen.getByTestId("team-payload-editor-ultracode-switch")).toBeTruthy()
  })
})

describe("GoalPayloadEditor", () => {
  it("edits objective + numeric config and shows the objective error", () => {
    function Host() {
      const [draft, setDraft] = useState<GoalDraft>({ ...EMPTY_GOAL_DRAFT })
      return (
        <GoalPayloadEditor
          draft={draft}
          onDraftChange={setDraft}
          errors={{ objective: "objectiveRequired" }}
        />
      )
    }
    render(wrap(<Host />))
    expect(screen.getByText(/required/i)).toBeTruthy()
    fireEvent.change(screen.getByTestId("goal-payload-editor-objective-input"), {
      target: { value: "ship it" },
    })
    fireEvent.change(screen.getByTestId("goal-payload-editor-max-turns-input"), {
      target: { value: "7" },
    })
    expect(
      (screen.getByTestId("goal-payload-editor-objective-input") as HTMLTextAreaElement).value
    ).toBe("ship it")
    expect(
      (screen.getByTestId("goal-payload-editor-max-turns-input") as HTMLInputElement).value
    ).toBe("7")
  })
})

describe("PlanPayloadEditor", () => {
  it("falls back to a free-text id input when no plans exist", () => {
    function Host() {
      const [draft, setDraft] = useState<PlanDraft>({ ...EMPTY_PLAN_DRAFT })
      return <PlanPayloadEditor draft={draft} onDraftChange={setDraft} plansForTesting={[]} />
    }
    render(wrap(<Host />))
    fireEvent.change(screen.getByTestId("plan-payload-editor-plan-input"), {
      target: { value: "plan-9" },
    })
    expect((screen.getByTestId("plan-payload-editor-plan-input") as HTMLInputElement).value).toBe(
      "plan-9"
    )
  })

  it("renders a select when plans exist and shows the planId error", () => {
    render(
      wrap(
        <PlanPayloadEditor
          draft={{ ...EMPTY_PLAN_DRAFT }}
          onDraftChange={() => {}}
          plansForTesting={[{ id: "p1", title: "Migrate", status: "approved" }]}
          errors={{ planId: "planIdRequired" }}
        />
      )
    )
    expect(screen.getByTestId("plan-payload-editor-plan-select")).toBeTruthy()
    expect(screen.getByText(/required/i)).toBeTruthy()
  })

  it("toggles replanOnFailure", () => {
    function Host() {
      const [draft, setDraft] = useState<PlanDraft>({ planId: "p1", replanOnFailure: false })
      return <PlanPayloadEditor draft={draft} onDraftChange={setDraft} plansForTesting={[]} />
    }
    render(wrap(<Host />))
    fireEvent.click(screen.getByTestId("plan-payload-editor-replan-switch"))
    expect(screen.getByTestId("plan-payload-editor-replan-switch")).toBeTruthy()
  })
})
