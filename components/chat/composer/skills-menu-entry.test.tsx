/**
 * @jest-environment jsdom
 */

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

const mockSkillIds: { current: string[] | undefined } = { current: [] }
const mockSetEphemeralSkillIds = jest.fn()

jest.mock("@/stores/chat/chat-store", () => ({
  useComposerEphemeralSkillIds: () => mockSkillIds.current,
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setEphemeralSkillIds: mockSetEphemeralSkillIds }),
}))

jest.mock("@/components/chat/skill-picker", () => ({
  SkillPickerContent: ({
    active,
    value,
    onChange,
  }: {
    active: boolean
    value: string[]
    onChange: (ids: string[]) => void
  }) =>
    active ? (
      <div
        data-testid="skill-picker-content"
        data-value={value.join(",")}
        onClick={() => onChange(["s1"])}
      />
    ) : null,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SkillsMenuEntry } from "./skills-menu-entry"
import type { ChatSession } from "@cognia/agent-config-types"

const session = { id: "sess-1" } as ChatSession

beforeEach(() => {
  mockSkillIds.current = []
  mockSetEphemeralSkillIds.mockClear()
})

describe("SkillsMenuEntry", () => {
  it("renders the capability row in the `+` menu", () => {
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("composer-skill-trigger")).toBeInTheDocument()
    // Flyout stays closed — and the skills table unread — until the row is hit.
    expect(screen.queryByTestId("skill-picker-content")).not.toBeInTheDocument()
  })

  it("opens the inline flyout from the row, not a dialog", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("composer-skill-trigger"))
    expect(screen.getByTestId("skill-picker-content")).toBeInTheDocument()
  })

  it("renders inactive when the session has no ids yet (undefined)", () => {
    mockSkillIds.current = undefined
    const { container } = render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("composer-skill-trigger")).toBeInTheDocument()
    expect(container.querySelector(".bg-primary")).toBeNull()
  })

  it("marks the row active once skills are attached", () => {
    mockSkillIds.current = ["s1"]
    const { container } = render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    // CapabilityRow draws the active dot as a primary-filled 1.5px span.
    expect(container.querySelector(".bg-primary")).not.toBeNull()
  })

  it("writes picks back to the per-session ephemeral-skill store", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("composer-skill-trigger"))
    fireEvent.click(screen.getByTestId("skill-picker-content"))
    expect(mockSetEphemeralSkillIds).toHaveBeenCalledWith(["s1"], "sess-1")
  })

  it("writes picks against the focused session when none is passed", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SkillsMenuEntry />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("composer-skill-trigger"))
    fireEvent.click(screen.getByTestId("skill-picker-content"))
    // `session?.id ?? null` — the store resolves null to the focused session.
    expect(mockSetEphemeralSkillIds).toHaveBeenCalledWith(["s1"], null)
  })

  it("passes disabled through to the row", () => {
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} disabled />
      </TooltipProvider>
    )
    expect(screen.getByTestId("composer-skill-trigger")).toBeDisabled()
  })
})
