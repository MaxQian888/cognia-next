import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Stub the renderer so we don't mount the SVG/live2d skin in this unit test.
jest.mock("../pet-renderer", () => ({
  PetRenderer: ({
    size,
    flavor,
    mood,
    lowPower,
  }: {
    size?: number
    flavor?: string
    mood?: string
    lowPower?: boolean
  }) => (
    <div
      data-testid="pet-preview"
      data-size={size}
      data-flavor={flavor}
      data-mood={mood}
      data-low-power={lowPower || undefined}
    />
  ),
}))

// Inventory strip's reactive read — empty so the strip stays hidden here.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

import { NurtureTab } from "./nurture-tab"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile } from "@/types/pet"

function setup() {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
  }
  const view = computePetView(profile, null, 0)
  const handlers = {
    onFeed: jest.fn(),
    onPlay: jest.fn(),
    onPet: jest.fn(),
    onTalk: jest.fn(),
    onSleep: jest.fn(),
    onClean: jest.fn(),
    onTreat: jest.fn(),
  }
  render(<NurtureTab profile={profile} view={view} lowPower {...handlers} />)
  return handlers
}

beforeEach(() => usePetStore.setState({ interactionRefusal: null }))

describe("NurtureTab", () => {
  it("renders the stat card, the three need bars, and a hero preview", () => {
    setup()
    expect(screen.getByTestId("pet-nurture-tab")).toBeInTheDocument()
    expect(screen.getByTestId("pet-stat-card")).toBeInTheDocument()
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(document.querySelector('[data-need="mood"]')).not.toBeNull()
    expect(document.querySelector('[data-need="bond"]')).not.toBeNull()
    // A large hero preview alongside the stat-card preview.
    const hero = screen.getAllByTestId("pet-preview").find((node) => node.dataset.size === "160")
    expect(hero).toBeDefined()
    expect(hero).toHaveAttribute("data-mood", "lonely")
    expect(hero).toHaveAttribute("data-low-power", "true")
  })

  it("wires feed/play/pet directly and toggles the talk composer", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/feed|actions\.feed/i))
    fireEvent.click(screen.getByLabelText(/play|actions\.play/i))
    fireEvent.click(screen.getByLabelText(/^pet$|actions\.pet/i))
    expect(h.onFeed).toHaveBeenCalled()
    expect(h.onPlay).toHaveBeenCalled()
    expect(h.onPet).toHaveBeenCalled()

    expect(screen.queryByTestId("pet-talk-composer")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    expect(screen.getByTestId("pet-talk-composer")).toBeInTheDocument()
    expect(h.onTalk).not.toHaveBeenCalled()
  })

  it("runs the new actions", () => {
    // The cooldown that follows is no longer this component's to start: the
    // controller persists the deadline and the grid renders the projection.
    // That contract is pinned in pet-action-grid.test.tsx.
    const h = setup()
    fireEvent.click(document.querySelector('[data-action="slept"]') as HTMLButtonElement)
    expect(h.onSleep).toHaveBeenCalled()

    fireEvent.click(document.querySelector('[data-action="cleaned"]') as HTMLButtonElement)
    expect(h.onClean).toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-action="treated"]') as HTMLButtonElement)
    expect(h.onTreat).toHaveBeenCalled()
  })

  it("shows the wallet strip and jumps to the shop via onOpenShop", () => {
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const view = computePetView(profile, null, 0)
    const onOpenShop = jest.fn()
    render(
      <NurtureTab
        profile={profile}
        view={view}
        onFeed={jest.fn()}
        onPlay={jest.fn()}
        onPet={jest.fn()}
        onTalk={jest.fn()}
        onSleep={jest.fn()}
        onClean={jest.fn()}
        onTreat={jest.fn()}
        onOpenShop={onOpenShop}
      />
    )
    fireEvent.click(screen.getByTestId("pet-wallet-strip"))
    expect(onOpenShop).toHaveBeenCalledTimes(1)
    // Mood/condition surface in the vitals card.
    expect(screen.getByTestId("pet-mood-chip")).toBeInTheDocument()
  })

  it("submits typed talk text and clears the input", async () => {
    const user = userEvent.setup()
    const h = setup()
    await user.click(screen.getByLabelText(/talk|actions\.talk/i))
    const input = screen.getByPlaceholderText("Say something to your pet…")
    await user.type(input, "  hi Boba  ")
    await user.keyboard("{Enter}")
    expect(h.onTalk).toHaveBeenCalledWith("hi Boba")
    expect(input).toHaveValue("")
  })

  it("puts the pet's state in its own column and the care actions at touch size", () => {
    setup()
    const status = screen.getByTestId("pet-nurture-status")
    expect(status).toContainElement(screen.getByTestId("pet-vitals-card"))
    // The 160px hero lives in the status column (the stat card has its own thumbnail).
    const hero = screen.getAllByTestId("pet-preview").find((el) => el.dataset.size === "160")
    expect(status).toContainElement(hero as HTMLElement)
    expect(screen.getByTestId("pet-action-grid")).toHaveAttribute("data-size", "comfortable")
    expect(
      screen.getByRole("heading", { name: /care|console\.nurture\.care/i })
    ).toBeInTheDocument()
  })

  it("explains how to bring an unwell pet back", () => {
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const view = { ...computePetView(profile, null, 0), condition: "unwell" as const }
    render(
      <NurtureTab
        profile={profile}
        view={view}
        onFeed={jest.fn()}
        onPlay={jest.fn()}
        onPet={jest.fn()}
        onTalk={jest.fn()}
        onSleep={jest.fn()}
        onClean={jest.fn()}
        onTreat={jest.fn()}
      />
    )
    expect(screen.getByTestId("pet-condition-hint")).toBeInTheDocument()
  })

  // Remote care (ADR-0219): talk is a plain care action (words go through the
  // chat tab), and the cooldowns are the desktop's.
  it("makes talk a direct action and reads the caller's cooldowns in remote care", () => {
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const onTalk = jest.fn()
    render(
      <NurtureTab
        profile={profile}
        view={computePetView(profile, null, 0)}
        onFeed={jest.fn()}
        onPlay={jest.fn()}
        onPet={jest.fn()}
        onTalk={onTalk}
        onSleep={jest.fn()}
        onClean={jest.fn()}
        onTreat={jest.fn()}
        talkMode="direct"
        cooldownRemaining={(kind) => (kind === "fed" ? 3000 : 0)}
      />
    )
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    expect(onTalk).toHaveBeenCalledWith()
    expect(screen.queryByTestId("pet-talk-composer")).not.toBeInTheDocument()
    expect(document.querySelector('[data-action="fed"]')).toBeDisabled()
  })
})
