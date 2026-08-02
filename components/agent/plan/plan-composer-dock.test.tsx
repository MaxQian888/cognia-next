/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanComposerDock } from "./plan-composer-dock"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockPlan = jest.fn()
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockPlan(),
}))

const mockPermissionMode = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { permissionMode: string | null }) => unknown) =>
    selector({ permissionMode: mockPermissionMode() }),
}))

jest.mock("./plan-composer-dialog", () => ({
  PlanComposerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="plan-composer-dialog" /> : null,
}))

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "manual",
    executionMode: "auto",
    steps: [],
    status: "draft",
    totalSteps: 0,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPlan.mockReturnValue(undefined)
  mockPermissionMode.mockReturnValue("plan")
})

describe("PlanComposerDock gating", () => {
  it("offers the affordance in plan mode with no open plan", () => {
    render(<PlanComposerDock sessionId="ses" />)
    expect(screen.getByTestId("plan-composer-open")).toBeInTheDocument()
  })

  it.each(["default", "acceptEdits", "bypassPermissions", null])(
    "self-hides outside plan mode (%s)",
    (mode) => {
      mockPermissionMode.mockReturnValue(mode)
      render(<PlanComposerDock sessionId="ses" />)
      expect(screen.queryByTestId("plan-composer-dock")).not.toBeInTheDocument()
    }
  )

  it.each(["draft", "awaiting_approval", "approved", "executing", "paused"] as const)(
    "self-hides while an open plan owns the slot (%s)",
    (status) => {
      mockPlan.mockReturnValue(plan({ status }))
      render(<PlanComposerDock sessionId="ses" />)
      expect(screen.queryByTestId("plan-composer-dock")).not.toBeInTheDocument()
    }
  )
})

describe("PlanComposerDock dialog", () => {
  it("opens the composer dialog on click", async () => {
    const user = userEvent.setup()
    render(<PlanComposerDock sessionId="ses" characterId="char_1" />)
    expect(screen.queryByTestId("plan-composer-dialog")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("plan-composer-open"))
    expect(screen.getByTestId("plan-composer-dialog")).toBeInTheDocument()
  })
})
