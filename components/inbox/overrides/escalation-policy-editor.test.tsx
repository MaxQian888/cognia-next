/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { EscalationPolicy } from "@/types/connectors/escalation"
import { EscalationPolicyEditor } from "./escalation-policy-editor"

const POLICY: EscalationPolicy = {
  steps: [
    { afterOverdueMinutes: 0, actions: [{ type: "notify" }] },
    {
      afterOverdueMinutes: 30,
      actions: [
        { type: "reassign", assignee: { kind: "team", id: "t1" } },
        { type: "switchMode", mode: "manual" },
        { type: "urgent", userIds: ["ou_1"], via: "sms" },
      ],
    },
  ],
}

beforeEach(() => {
  useAgentTeamStore.setState({ teams: { t1: { id: "t1", name: "Ops" } } as never })
})

describe("EscalationPolicyEditor — conversation scope", () => {
  it("renders the inherit switch off for an undefined value and turns override on with an empty chain", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor
        scope="conversation"
        platform="lark"
        value={undefined}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("escalation-override")).toHaveAttribute("data-state", "unchecked")
    expect(screen.queryByTestId("escalation-add-step")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("escalation-override"))
    expect(onChange).toHaveBeenCalledWith({ steps: [] })
  })

  it("turning the override off hands back undefined (inherit)", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor
        scope="conversation"
        platform="lark"
        value={POLICY}
        onChange={onChange}
      />
    )
    await user.click(screen.getByTestId("escalation-override"))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("shows the empty hint for an active-but-empty chain and adds a first step (notify, 0 min)", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor
        scope="conversation"
        platform="lark"
        value={{ steps: [] }}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("escalation-empty")).toBeInTheDocument()
    await user.click(screen.getByTestId("escalation-add-step"))
    expect(onChange).toHaveBeenCalledWith({
      steps: [{ afterOverdueMinutes: 0, actions: [{ type: "notify" }] }],
    })
  })
})

describe("EscalationPolicyEditor — steps", () => {
  it("adds a step 15 min after the last, removes a step, and edits minutes", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor scope="adapter" platform="lark" value={POLICY} onChange={onChange} />
    )
    // Adapter scope: no override switch.
    expect(screen.queryByTestId("escalation-override")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("escalation-add-step"))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [...POLICY.steps, { afterOverdueMinutes: 45, actions: [{ type: "notify" }] }],
    })

    await user.click(screen.getByTestId("escalation-step-0-remove"))
    expect(onChange).toHaveBeenLastCalledWith({ steps: [POLICY.steps[1]] })

    fireEvent.change(screen.getByTestId("escalation-step-1-minutes"), { target: { value: "60" } })
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [POLICY.steps[0], { ...POLICY.steps[1], afterOverdueMinutes: 60 }],
    })
  })

  it("toggles notify, sets a reassign target, and switches mode", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{ steps: [{ afterOverdueMinutes: 5, actions: [] }] }}
        onChange={onChange}
        characters={[{ id: "c1", name: "Ava" }]}
      />
    )
    await user.click(screen.getByTestId("escalation-step-0-notify"))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [{ afterOverdueMinutes: 5, actions: [{ type: "notify" }] }],
    })

    await user.click(screen.getByTestId("escalation-step-0-reassign"))
    await user.click(await screen.findByRole("option", { name: /Me \(human/ }))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [
        { afterOverdueMinutes: 5, actions: [{ type: "reassign", assignee: { kind: "human" } }] },
      ],
    })

    await user.click(screen.getByTestId("escalation-step-0-switch-mode"))
    await user.click(await screen.findByRole("option", { name: /Draft/ }))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [{ afterOverdueMinutes: 5, actions: [{ type: "switchMode", mode: "draft" }] }],
    })
  })

  it("picks a character / team for reassign through the shared pickers", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{
          steps: [
            {
              afterOverdueMinutes: 5,
              actions: [{ type: "reassign", assignee: { kind: "character", id: "" } }],
            },
          ],
        }}
        onChange={onChange}
        characters={[{ id: "c1", name: "Ava" }]}
      />
    )
    await user.click(screen.getByTestId("escalation-step-0-reassign-character"))
    await user.click(await screen.findByRole("option", { name: "Ava" }))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [
        {
          afterOverdueMinutes: 5,
          actions: [{ type: "reassign", assignee: { kind: "character", id: "c1", label: "Ava" } }],
        },
      ],
    })

    rerender(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{
          steps: [
            {
              afterOverdueMinutes: 5,
              actions: [{ type: "reassign", assignee: { kind: "team", id: "" } }],
            },
          ],
        }}
        onChange={onChange}
      />
    )
    await user.click(screen.getByTestId("team-picker-trigger"))
    await user.click(await screen.findByRole("option", { name: "Ops" }))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [
        {
          afterOverdueMinutes: 5,
          actions: [{ type: "reassign", assignee: { kind: "team", id: "t1" } }],
        },
      ],
    })
  })

  it("replaces an existing action in place instead of appending (order preserved)", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor scope="adapter" platform="lark" value={POLICY} onChange={onChange} />
    )
    await user.click(screen.getByTestId("escalation-step-1-switch-mode"))
    await user.click(await screen.findByRole("option", { name: /Draft/ }))
    const next = onChange.mock.calls.at(-1)?.[0] as EscalationPolicy
    expect(next.steps[1].actions.map((a) => a.type)).toEqual(["reassign", "switchMode", "urgent"])
    expect(next.steps[1].actions[1]).toEqual({ type: "switchMode", mode: "draft" })
  })

  it("surfaces validation issues for a malformed chain", () => {
    render(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{
          steps: [
            { afterOverdueMinutes: 10, actions: [{ type: "notify" }] },
            { afterOverdueMinutes: 5, actions: [] },
          ],
        }}
        onChange={jest.fn()}
      />
    )
    const issues = screen.getByTestId("escalation-issues")
    expect(issues).toHaveTextContent("Step 2: minutes must be greater than the previous step.")
    expect(issues).toHaveTextContent("Step 2: pick at least one action.")
  })

  it("translates every validation issue code", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      afterOverdueMinutes: i === 3 ? 1.5 : i,
      actions:
        i === 4
          ? [
              { type: "bogus" } as never,
              { type: "reassign" as const, assignee: { kind: "team" as const, id: "" } },
              { type: "switchMode" as const, mode: "auto" as never },
              { type: "urgent" as const, userIds: [] },
            ]
          : [{ type: "notify" as const }],
    }))
    render(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{ steps }}
        onChange={jest.fn()}
      />
    )
    const issues = screen.getByTestId("escalation-issues")
    expect(issues).toHaveTextContent("At most 10 steps.")
    expect(issues).toHaveTextContent("Step 4: minutes must be a whole number ≥ 0.")
    expect(issues).toHaveTextContent("Step 5: unknown action.")
    expect(issues).toHaveTextContent("Step 5: pick who to reassign to.")
    expect(issues).toHaveTextContent("Step 5: invalid mode.")
    expect(issues).toHaveTextContent("Step 5: add at least one Lark user open_id.")
  })

  it("clears the reassign action when 'No reassignment' is chosen and blanks the minutes on empty input", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor scope="adapter" platform="lark" value={POLICY} onChange={onChange} />
    )
    await user.click(screen.getByTestId("escalation-step-1-reassign"))
    await user.click(await screen.findByRole("option", { name: "No reassignment" }))
    const next = onChange.mock.calls.at(-1)?.[0] as EscalationPolicy
    expect(next.steps[1].actions.map((a) => a.type)).toEqual(["switchMode", "urgent"])
    fireEvent.change(screen.getByTestId("escalation-step-0-minutes"), { target: { value: "" } })
    const blank = onChange.mock.calls.at(-1)?.[0] as EscalationPolicy
    expect(Number.isNaN(blank.steps[0].afterOverdueMinutes)).toBe(true)
  })

  it("disables Add step at the 10-step cap", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      afterOverdueMinutes: i,
      actions: [{ type: "notify" as const }],
    }))
    render(
      <EscalationPolicyEditor
        scope="adapter"
        platform="lark"
        value={{ steps }}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("escalation-add-step")).toBeDisabled()
    expect(screen.getByText("At most 10 steps.")).toBeInTheDocument()
  })
})

describe("EscalationPolicyEditor — urgent (Lark-only dormancy pin)", () => {
  it("on Lark the urgent switch is enabled and edits user ids + channel", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(
      <EscalationPolicyEditor scope="adapter" platform="lark" value={POLICY} onChange={onChange} />
    )
    expect(screen.getByTestId("escalation-step-0-urgent")).toBeEnabled()
    expect(screen.queryByTestId("escalation-step-0-urgent-lark-only")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("escalation-step-0-urgent"))
    expect(onChange).toHaveBeenLastCalledWith({
      steps: [
        {
          afterOverdueMinutes: 0,
          actions: [{ type: "notify" }, { type: "urgent", userIds: [], via: "app" }],
        },
        POLICY.steps[1],
      ],
    })

    fireEvent.change(screen.getByTestId("escalation-step-1-urgent-users"), {
      target: { value: "ou_a\nou_b, ou_c" },
    })
    const afterUsers = onChange.mock.calls.at(-1)?.[0] as EscalationPolicy
    expect(afterUsers.steps[1].actions[2]).toEqual({
      type: "urgent",
      userIds: ["ou_a", "ou_b", "ou_c"],
      via: "sms",
    })

    await user.click(screen.getByTestId("escalation-step-1-urgent-via"))
    await user.click(await screen.findByRole("option", { name: "Phone" }))
    const afterVia = onChange.mock.calls.at(-1)?.[0] as EscalationPolicy
    expect(afterVia.steps[1].actions[2]).toEqual({
      type: "urgent",
      userIds: ["ou_1"],
      via: "phone",
    })
  })

  it.each(["telegram", "discord", "slack", "wecom", undefined])(
    "on %s the urgent controls are disabled and explain why (inert by design)",
    (platform) => {
      render(
        <EscalationPolicyEditor
          scope="adapter"
          platform={platform}
          value={POLICY}
          onChange={jest.fn()}
        />
      )
      expect(screen.getByTestId("escalation-step-0-urgent")).toBeDisabled()
      expect(screen.getByTestId("escalation-step-0-urgent-lark-only")).toHaveTextContent(
        "only available on Lark"
      )
      // A persisted urgent action on a non-Lark row stays visible but locked.
      expect(screen.getByTestId("escalation-step-1-urgent")).toBeDisabled()
      expect(screen.getByTestId("escalation-step-1-urgent-users")).toBeDisabled()
      // The other actions remain editable.
      expect(screen.getByTestId("escalation-step-0-notify")).toBeEnabled()
    }
  )

  it("respects the disabled prop across every control", () => {
    render(
      <EscalationPolicyEditor
        scope="conversation"
        platform="lark"
        value={POLICY}
        onChange={jest.fn()}
        disabled
      />
    )
    expect(screen.getByTestId("escalation-override")).toBeDisabled()
    expect(screen.getByTestId("escalation-step-0-notify")).toBeDisabled()
    expect(screen.getByTestId("escalation-step-0-minutes")).toBeDisabled()
    expect(screen.getByTestId("escalation-add-step")).toBeDisabled()
    expect(screen.getByTestId("escalation-step-0-remove")).toBeDisabled()
  })
})
