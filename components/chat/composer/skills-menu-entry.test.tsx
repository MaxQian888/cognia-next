/**
 * @jest-environment jsdom
 */

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

const mockIsMobile = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockIsMobile.current }))

const mockSkillIds: { current: string[] | undefined } = { current: [] }
const mockSetEphemeralSkillIds = jest.fn()

jest.mock("@/stores/chat/chat-store", () => ({
  useComposerEphemeralSkillIds: () => mockSkillIds.current,
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setEphemeralSkillIds: mockSetEphemeralSkillIds }),
}))

jest.mock("@/components/chat/skill-picker", () => ({
  SkillPickerPanel: ({
    active,
    value,
    onChange,
  }: {
    active: boolean
    value: string[]
    onChange: (ids: string[]) => void
  }) => (
    <div
      data-testid="skill-picker-panel"
      data-active={String(active)}
      data-value={value.join(",")}
      onClick={() => onChange(["s2"])}
    />
  ),
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

import { useCallback, useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerMenuPanelsProvider, type ComposerMenuPanels } from "./composer-menu-context"
import { SKILLS_MENU_PANEL_ID, SkillsMenuEntry } from "./skills-menu-entry"
import type { ChatSession } from "@cognia/agent-config-types"

const session = { id: "sess-1" } as ChatSession

beforeEach(() => {
  mockIsMobile.current = false
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

  // jsdom lays everything out at 0×0, so Radix may flip the side; the AXIS is
  // what the placement decides.
  it("flies out sideways on a wide screen", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("composer-skill-trigger"))
    expect(["right", "left"]).toContain(
      screen.getByTestId("composer-skill-flyout").getAttribute("data-side")
    )
  })

  // On a phone neither side of the `+` menu can hold the panel, and Radix only
  // flips to the opposite side, so a right-hand flyout ran off the screen.
  it("stacks the flyout above its row on a phone, clamped to the viewport", async () => {
    mockIsMobile.current = true
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SkillsMenuEntry session={session} />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("composer-skill-trigger"))
    const flyout = screen.getByTestId("composer-skill-flyout")
    expect(["top", "bottom"]).toContain(flyout.getAttribute("data-side"))
    expect(flyout.className).toContain("max-w-[calc(100vw-1rem)]")
  })
})

/**
 * A minimal drill-in host, standing in for the mobile `+` sheet: one slot, one
 * active panel id, and the title it was opened with.
 */
function SheetHost({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<{ id: string; title: string } | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const registerPanel = useCallback(() => () => {}, [])
  const panels: ComposerMenuPanels = {
    activePanelId: active?.id ?? null,
    slot,
    openPanel: (id, title) => setActive({ id, title }),
    closePanel: () => setActive(null),
    registerPanel,
  }
  return (
    <ComposerMenuPanelsProvider value={panels}>
      {children}
      <p data-testid="sheet-title">{active?.title ?? ""}</p>
      <div data-testid="sheet-slot" ref={setSlot} />
    </ComposerMenuPanelsProvider>
  )
}

describe("SkillsMenuEntry inside the mobile sheet", () => {
  function renderInSheet(props: React.ComponentProps<typeof SkillsMenuEntry> = { session }) {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SheetHost>
          <SkillsMenuEntry {...props} />
        </SheetHost>
      </TooltipProvider>
    )
    return user
  }

  it("drills the sheet in to the skill list instead of floating a popover", async () => {
    const user = renderInSheet()
    expect(screen.queryByTestId("skill-picker-panel")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("composer-skill-trigger"))
    expect(screen.queryByTestId("composer-skill-flyout")).not.toBeInTheDocument()
    expect(screen.getByTestId("sheet-slot")).toContainElement(
      screen.getByTestId("skill-picker-panel")
    )
    // Titled by the row's own label (the global next-intl mock resolves en).
    expect(screen.getByTestId("sheet-title")).toHaveTextContent("Attach skill")
    // The live skills read starts only once the panel is showing.
    expect(screen.getByTestId("skill-picker-panel")).toHaveAttribute("data-active", "true")
  })

  it("announces the panel it opens and whether it is showing", async () => {
    const user = renderInSheet()
    const trigger = screen.getByTestId("composer-skill-trigger")
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("applies picks for the turn exactly as the flyout does", async () => {
    mockSkillIds.current = ["s1"]
    const user = renderInSheet()
    await user.click(screen.getByTestId("composer-skill-trigger"))
    expect(screen.getByTestId("skill-picker-panel")).toHaveAttribute("data-value", "s1")
    fireEvent.click(screen.getByTestId("skill-picker-panel"))
    expect(mockSetEphemeralSkillIds).toHaveBeenCalledWith(["s2"], "sess-1")
  })

  it("keeps the row disabled while a turn streams", () => {
    renderInSheet({ session, disabled: true })
    expect(screen.getByTestId("composer-skill-trigger")).toBeDisabled()
  })

  it("goes by a stable panel id", () => {
    expect(SKILLS_MENU_PANEL_ID).toBe("skills")
  })
})
