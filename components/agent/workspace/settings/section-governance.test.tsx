/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

// Stub ConfirmActionDialog so we control confirm/cancel in tests.
jest.mock("./confirm-action-dialog", () => ({
  ConfirmActionDialog: ({
    open,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    onConfirm: () => void
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div data-testid="gov-confirm-dialog">
        <button data-testid="gov-confirm-yes" onClick={onConfirm}>
          yes
        </button>
        <button data-testid="gov-confirm-no" onClick={() => onOpenChange(false)}>
          no
        </button>
      </div>
    ) : null,
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

import { GovernanceSection } from "./section-governance"
import type { AgentTeam, TeamGovernancePolicy } from "@/types/agent/agent-team"
import { within } from "@testing-library/react"

const DEFAULT_POLICY: TeamGovernancePolicy = {
  approval: { requirePlanApproval: false, requireDelegationApproval: false },
  budget: { tokenBudget: 0, warningThreshold: 0.8, criticalThreshold: 0.95, onCritical: "notify" },
  escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
}

function makeTeam(
  policyOverride?: Partial<TeamGovernancePolicy>,
  configExtra?: Partial<AgentTeam["config"]>
): AgentTeam {
  const policy = policyOverride
    ? {
        ...DEFAULT_POLICY,
        ...policyOverride,
        approval: { ...DEFAULT_POLICY.approval, ...(policyOverride.approval ?? {}) },
        budget: { ...DEFAULT_POLICY.budget, ...(policyOverride.budget ?? {}) },
        escalation: { ...DEFAULT_POLICY.escalation, ...(policyOverride.escalation ?? {}) },
      }
    : DEFAULT_POLICY
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
      governancePolicy: policy,
      ...configExtra,
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
  markSavedMock.mockReset()
})

describe("GovernanceSection", () => {
  it("renders the title and description", () => {
    render(<GovernanceSection team={makeTeam()} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("description")).toBeInTheDocument()
  })

  it("renders with default policy when governancePolicy is absent", () => {
    const team = makeTeam()
    delete (team.config as Partial<AgentTeam["config"]>).governancePolicy
    render(<GovernanceSection team={team} />)
    // Should render without error and show heading keys.
    expect(screen.getByText("approval.heading")).toBeInTheDocument()
  })

  it("renders all governance switches incl. adaptive re-planning + progress ledger + refusal detect", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    // 13 switches: 4 approval (incl. the ADR-0071 task review) + 2 escalation
    // + 2 adaptiveReplan + 3 progressLedger + 1 refusal detect + 1 nudges
    expect(switches.length).toBe(13)
  })

  it("toggles progressLedger.enabled and patches the config", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[8]!) // progressLedger.enabled
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ progressLedger: expect.objectContaining({ enabled: true }) })
    )
  })

  it("disables the autonomous consensus/delegation switches until the ledger is enabled", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[9]!).toBeDisabled() // allowAutonomousConsensus
    expect(switches[10]!).toBeDisabled() // allowAutonomousDelegation
  })

  it("toggles allowAutonomousConsensus once the ledger is enabled", () => {
    render(<GovernanceSection team={makeTeam(undefined, { progressLedger: { enabled: true } })} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[9]!).not.toBeDisabled()
    fireEvent.click(switches[9]!)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        progressLedger: expect.objectContaining({ allowAutonomousConsensus: true }),
      })
    )
  })

  it("toggles allowAutonomousDelegation once the ledger is enabled", () => {
    render(<GovernanceSection team={makeTeam(undefined, { progressLedger: { enabled: true } })} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[10]!).not.toBeDisabled()
    fireEvent.click(switches[10]!)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        progressLedger: expect.objectContaining({ allowAutonomousDelegation: true }),
      })
    )
  })

  describe("blocking lead review (ADR-0071)", () => {
    it("is off by default", () => {
      render(<GovernanceSection team={makeTeam()} />)
      expect(screen.getByTestId("task-review-toggle")).not.toBeChecked()
      // The revision budget is meaningless until review is on.
      expect(screen.queryByTestId("task-review-max-revisions")).not.toBeInTheDocument()
    })

    it("enables review and patches the team config", () => {
      render(<GovernanceSection team={makeTeam()} />)

      fireEvent.click(screen.getByTestId("task-review-toggle"))

      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ taskReview: expect.objectContaining({ enabled: true }) })
      )
    })

    it("reveals the revision budget, defaulted, once review is on", () => {
      render(<GovernanceSection team={makeTeam(undefined, { taskReview: { enabled: true } })} />)
      expect(screen.getByTestId("task-review-max-revisions")).toHaveValue(2)
    })

    it("persists an edited revision budget", () => {
      render(<GovernanceSection team={makeTeam(undefined, { taskReview: { enabled: true } })} />)

      const input = screen.getByTestId("task-review-max-revisions")
      fireEvent.change(input, { target: { value: "4" } })
      fireEvent.blur(input)

      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          taskReview: expect.objectContaining({ enabled: true, maxRevisions: 4 }),
        })
      )
    })

    it("clamps a nonsense budget instead of persisting it", () => {
      render(<GovernanceSection team={makeTeam(undefined, { taskReview: { enabled: true } })} />)

      const input = screen.getByTestId("task-review-max-revisions")
      fireEvent.change(input, { target: { value: "-9" } })
      fireEvent.blur(input)

      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ taskReview: expect.objectContaining({ maxRevisions: 0 }) })
      )
    })

    it("keeps the enabled flag when only the budget changes", () => {
      render(<GovernanceSection team={makeTeam(undefined, { taskReview: { enabled: true } })} />)

      const input = screen.getByTestId("task-review-max-revisions")
      fireEvent.change(input, { target: { value: "1" } })
      fireEvent.blur(input)

      const patch = updateTeamConfigMock.mock.calls.at(-1)?.[1] as {
        taskReview?: { enabled?: boolean }
      }
      expect(patch.taskReview?.enabled).toBe(true)
    })
  })

  it("toggles requireResultReview and patches the governance policy", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[2]!) // approval.requireResultReview
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          approval: expect.objectContaining({ requireResultReview: true }),
        }),
      })
    )
  })

  it("toggles adaptiveReplan.enabled and patches the config", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[6]!) // adaptiveReplan.enabled
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ adaptiveReplan: expect.objectContaining({ enabled: true }) })
    )
  })

  it("toggles adaptiveReplan.requireApproval and patches the config", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[7]!) // adaptiveReplan.requireApproval
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        adaptiveReplan: expect.objectContaining({ requireApproval: true }),
      })
    )
  })

  it("toggles requirePlanApproval and patches the policy", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          approval: { requirePlanApproval: false, requireDelegationApproval: false },
        })}
      />
    )
    const [requirePlan] = screen.getAllByRole("switch")
    expect(requirePlan).not.toBeChecked()
    fireEvent.click(requirePlan)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          approval: expect.objectContaining({ requirePlanApproval: true }),
        }),
      })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("toggles requireDelegationApproval and patches the policy", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          approval: { requirePlanApproval: false, requireDelegationApproval: false },
        })}
      />
    )
    const [, requireDelegation] = screen.getAllByRole("switch")
    fireEvent.click(requireDelegation)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          approval: expect.objectContaining({ requireDelegationApproval: true }),
        }),
      })
    )
  })

  it("updates tokenBudget on change", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    // The budget token input should be the first number input.
    const inputs = screen.getAllByRole("spinbutton")
    const tokenInput = inputs[0]
    fireEvent.change(tokenInput, { target: { value: "5000" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ tokenBudget: 5000 }),
        }),
      })
    )
  })

  it("clamps tokenBudget to 0 for non-numeric input", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const inputs = screen.getAllByRole("spinbutton")
    fireEvent.change(inputs[0], { target: { value: "abc" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ tokenBudget: 0 }),
        }),
      })
    )
  })

  it("updates warningThreshold on change", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const inputs = screen.getAllByRole("spinbutton")
    fireEvent.change(inputs[1], { target: { value: "0.7" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ warningThreshold: 0.7 }),
        }),
      })
    )
  })

  it("clamps warningThreshold to 0 for NaN", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const inputs = screen.getAllByRole("spinbutton")
    fireEvent.change(inputs[1], { target: { value: "xyz" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ warningThreshold: 0 }),
        }),
      })
    )
  })

  it("updates criticalThreshold on change", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const inputs = screen.getAllByRole("spinbutton")
    fireEvent.change(inputs[2], { target: { value: "0.9" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ criticalThreshold: 0.9 }),
        }),
      })
    )
  })

  it("onCritical safe value (reduce_concurrency) patches immediately without dialog", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    // "reduce_concurrency" maps to i18n key "reduce_concurrency" → t returns the key.
    fireEvent.click(within(listbox).getByText("reduce_concurrency"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ onCritical: "reduce_concurrency" }),
        }),
      })
    )
    expect(screen.queryByTestId("gov-confirm-dialog")).not.toBeInTheDocument()
  })

  it("onCritical dangerous value (pause_for_review) opens confirm dialog first", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("pause_for_review"))
    expect(screen.getByTestId("gov-confirm-dialog")).toBeInTheDocument()
    expect(updateTeamConfigMock).not.toHaveBeenCalled()
  })

  it("confirms dangerous onCritical change and calls updateTeamConfig", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("pause_for_review"))
    // Dialog is open — confirm
    fireEvent.click(screen.getByTestId("gov-confirm-yes"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ onCritical: "pause_for_review" }),
        }),
      })
    )
  })

  it("cancels dangerous onCritical change and does NOT call updateTeamConfig", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("handoff_to_background"))
    fireEvent.click(screen.getByTestId("gov-confirm-no"))
    expect(updateTeamConfigMock).not.toHaveBeenCalled()
  })

  it("toggles allowOperatorPatternOverride", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
        })}
      />
    )
    const switches = screen.getAllByRole("switch")
    // Index 2 = allowOperatorPatternOverride (after requirePlan, requireDelegation)
    const allowOverride = switches[4]
    expect(allowOverride).toBeChecked()
    fireEvent.click(allowOverride)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          escalation: expect.objectContaining({ allowOperatorPatternOverride: false }),
        }),
      })
    )
  })

  it("toggles pauseOnHighRisk", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
        })}
      />
    )
    const switches = screen.getAllByRole("switch")
    const pauseOnHighRisk = switches[5]
    expect(pauseOnHighRisk).not.toBeChecked()
    fireEvent.click(pauseOnHighRisk)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          escalation: expect.objectContaining({ pauseOnHighRisk: true }),
        }),
      })
    )
  })

  it("toggles detectRefusal", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    const detectRefusal = switches[11]
    expect(detectRefusal).not.toBeChecked()
    fireEvent.click(detectRefusal)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ detectRefusal: true })
    )
  })

  it("updates refusalPatterns from the textarea", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "pattern1\npattern2" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ refusalPatterns: ["pattern1", "pattern2"] })
    )
  })

  it("refusalPatterns filters out blank lines", () => {
    render(<GovernanceSection team={makeTeam()} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "a\n  \nb" } })
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ refusalPatterns: ["a", "b"] })
    )
  })

  it("renders existing refusalPatterns in the textarea", () => {
    render(<GovernanceSection team={makeTeam(undefined, { refusalPatterns: ["x", "y"] })} />)
    const textarea = screen.getByRole("textbox")
    expect(textarea).toHaveValue("x\ny")
  })

  it("detectRefusal is checked when set to true", () => {
    render(<GovernanceSection team={makeTeam(undefined, { detectRefusal: true })} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[11]).toBeChecked()
  })

  it("applyOnCritical via confirm dialog covers patchPolicy with the pending action", () => {
    // This verifies that confirming the dialog triggers applyOnCritical, covering line 298.
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("pause_for_review"))
    expect(screen.getByTestId("gov-confirm-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("gov-confirm-yes"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ onCritical: "pause_for_review" }),
        }),
      })
    )
  })

  it("ConfirmActionDialog onOpenChange(false) clears pendingCritical (covers line 290)", () => {
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "notify",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("pause_for_review"))
    expect(screen.getByTestId("gov-confirm-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("gov-confirm-no"))
    expect(screen.queryByTestId("gov-confirm-dialog")).not.toBeInTheDocument()
    expect(updateTeamConfigMock).not.toHaveBeenCalled()
  })

  it("onCritical notify (safe) calls updateTeamConfig directly without confirm dialog", () => {
    // Start with reduce_concurrency as current, switch to notify (safe path).
    render(
      <GovernanceSection
        team={makeTeam({
          budget: {
            tokenBudget: 0,
            warningThreshold: 0.8,
            criticalThreshold: 0.95,
            onCritical: "reduce_concurrency",
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("notify"))
    expect(screen.queryByTestId("gov-confirm-dialog")).not.toBeInTheDocument()
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        governancePolicy: expect.objectContaining({
          budget: expect.objectContaining({ onCritical: "notify" }),
        }),
      })
    )
  })

  // `config.nudges` has been honoured by the runtime since it was added but had
  // no UI, so every team silently ran on the defaults.
  describe("rate-limit nudges", () => {
    it("shows the runtime defaults when the team has never set them", () => {
      render(<GovernanceSection team={makeTeam()} />)
      expect(screen.getByTestId("governance-nudges")).toBeInTheDocument()
      expect(screen.getByTestId("nudges-enabled")).toBeChecked()
      expect(screen.getByTestId("nudges-max-per-hour")).toHaveValue(2)
      expect(screen.getByTestId("nudges-busy-window")).toHaveValue(60000)
    })

    it("reflects a team's stored overrides", () => {
      render(
        <GovernanceSection
          team={makeTeam(undefined, {
            nudges: { enabled: false, maxPerMemberPerHour: 7, busySignalWindowMs: 5_000 },
          })}
        />
      )
      expect(screen.getByTestId("nudges-enabled")).not.toBeChecked()
      expect(screen.getByTestId("nudges-max-per-hour")).toHaveValue(7)
      expect(screen.getByTestId("nudges-busy-window")).toHaveValue(5000)
    })

    it("disables the numeric guards while nudges are switched off", () => {
      render(<GovernanceSection team={makeTeam(undefined, { nudges: { enabled: false } })} />)
      expect(screen.getByTestId("nudges-max-per-hour")).toBeDisabled()
      expect(screen.getByTestId("nudges-busy-window")).toBeDisabled()
    })

    it("persists a toggle while filling in the defaults for untouched guards", () => {
      render(<GovernanceSection team={makeTeam()} />)
      fireEvent.click(screen.getByTestId("nudges-enabled"))
      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          nudges: { enabled: false, maxPerMemberPerHour: 2, busySignalWindowMs: 60_000 },
        })
      )
    })

    it("clamps the per-hour cap into range instead of writing nonsense", () => {
      render(<GovernanceSection team={makeTeam()} />)
      fireEvent.change(screen.getByTestId("nudges-max-per-hour"), { target: { value: "999" } })
      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ nudges: expect.objectContaining({ maxPerMemberPerHour: 20 }) })
      )

      updateTeamConfigMock.mockReset()
      fireEvent.change(screen.getByTestId("nudges-max-per-hour"), { target: { value: "-4" } })
      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ nudges: expect.objectContaining({ maxPerMemberPerHour: 0 }) })
      )
    })

    it("clamps the busy-signal window and preserves the other guards", () => {
      render(
        <GovernanceSection
          team={makeTeam(undefined, { nudges: { enabled: true, maxPerMemberPerHour: 5 } })}
        />
      )
      fireEvent.change(screen.getByTestId("nudges-busy-window"), { target: { value: "9999999" } })
      expect(updateTeamConfigMock).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          nudges: { enabled: true, maxPerMemberPerHour: 5, busySignalWindowMs: 600_000 },
        })
      )
    })
  })
})
