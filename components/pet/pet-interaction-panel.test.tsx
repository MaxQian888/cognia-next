import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

// Stub the renderer so the stat-card preview's resolved skin is observable
// without mounting the live2d skin (stores + canvas) in this unit test.
jest.mock("./pet-renderer", () => ({
  PetRenderer: ({ skinId }: { skinId?: string }) => (
    <div data-testid="pet-preview" data-skin={skinId ?? "default"} />
  ),
}))

// Plugin slot host — captured to assert the point + safe context bag.
const slotProps = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: unknown) => {
    slotProps(props)
    return <div data-testid="pet-panel-slot" />
  },
}))

// Inventory strip's reactive read — empty by default, per-test override.
let inventoryValue: unknown = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => inventoryValue,
}))

import { PetInteractionPanel } from "./pet-interaction-panel"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile } from "@/types/pet"

function makeHandlers() {
  return {
    onFeed: jest.fn(),
    onPlay: jest.fn(),
    onPet: jest.fn(),
    onTalk: jest.fn(),
    onSleep: jest.fn(),
    onClean: jest.fn(),
    onTreat: jest.fn(),
  }
}

function setup() {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
  }
  const view = computePetView(profile, null, 0)
  const handlers = makeHandlers()
  render(<PetInteractionPanel profile={profile} view={view} {...handlers} />)
  return handlers
}

describe("PetInteractionPanel", () => {
  beforeEach(() => {
    window.localStorage.clear()
    usePetStore.setState({ actionCooldowns: {} })
    inventoryValue = []
  })

  it("renders the stat card and the three need bars", () => {
    setup()
    expect(screen.getByTestId("pet-interaction-panel")).toHaveClass("max-h-[calc(100dvh-2rem)]")
    expect(screen.getByTestId("pet-stat-card")).toBeInTheDocument()
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(document.querySelector('[data-need="mood"]')).not.toBeNull()
    expect(document.querySelector('[data-need="bond"]')).not.toBeNull()
  })

  it("forwards skinId to the stat-card preview (defaults to SVG)", () => {
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const view = computePetView(profile, null, 0)
    const handlers = makeHandlers()
    const { rerender } = render(<PetInteractionPanel profile={profile} view={view} {...handlers} />)
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("default")
    rerender(<PetInteractionPanel profile={profile} view={view} {...handlers} skinId="live2d" />)
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("live2d")
  })

  it("wires feed/play/pet directly; talk toggles the composer", () => {
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
    // Toggling talk alone never emits the event.
    expect(h.onTalk).not.toHaveBeenCalled()
  })

  it("submits typed talk text and clears the input", async () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    const input = screen.getByPlaceholderText("Say something to your pet…")
    fireEvent.change(input, { target: { value: "  hi Boba  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith("hi Boba"))
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("recalls a previously said phrase with ArrowUp", async () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    const input = screen.getByPlaceholderText("Say something to your pet…")
    fireEvent.change(input, { target: { value: "good boy" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith("good boy"))
    await waitFor(() => expect(input).toHaveValue(""))
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(input).toHaveValue("good boy")
  })

  it("submits bare talk (no text) as undefined via the send button", async () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    fireEvent.click(screen.getByLabelText("Send"))
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith(undefined))
  })

  it("mounts the pet.panel.actions slot with the safe context bag", () => {
    setup()
    expect(screen.getByTestId("pet-panel-slot")).toBeInTheDocument()
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({
        point: "pet.panel.actions",
        limit: 4,
        context: expect.objectContaining({
          level: expect.any(Number),
          stage: "baby",
        }),
      })
    )
  })

  it("renders the wallet strip and hides quick-nav without onOpenConsole", () => {
    setup()
    const wallet = screen.getByTestId("pet-wallet-strip")
    expect(wallet.tagName).toBe("DIV") // no shop jump without a navigation target
    expect(screen.queryByTestId("pet-quick-nav")).toBeNull()
  })

  it("routes wallet + quick-nav through onOpenConsole when provided", () => {
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const view = computePetView(profile, null, 0)
    const onOpenConsole = jest.fn()
    render(
      <PetInteractionPanel
        profile={profile}
        view={view}
        {...makeHandlers()}
        onOpenConsole={onOpenConsole}
      />
    )
    fireEvent.click(screen.getByTestId("pet-wallet-strip"))
    expect(onOpenConsole).toHaveBeenCalledWith("shop")
    fireEvent.click(document.querySelector('[data-nav="dex"]') as Element)
    expect(onOpenConsole).toHaveBeenCalledWith("dex")
  })

  it("shows the inventory quick-use strip by default and hides it when disabled", () => {
    inventoryValue = [{ id: "berry", qty: 1 }]
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    const view = computePetView(profile, null, 0)
    const { rerender } = render(
      <PetInteractionPanel profile={profile} view={view} {...makeHandlers()} />
    )
    expect(screen.getByTestId("pet-inventory-strip")).toBeInTheDocument()
    rerender(
      <PetInteractionPanel
        profile={profile}
        view={view}
        {...makeHandlers()}
        showInventory={false}
      />
    )
    expect(screen.queryByTestId("pet-inventory-strip")).toBeNull()
  })

  it("surfaces the derived mood in the vitals card", () => {
    setup()
    expect(screen.getByTestId("pet-mood-chip")).toBeInTheDocument()
  })

  it("wires sleep/clean/treat actions", () => {
    const h = setup()
    fireEvent.click(document.querySelector('[data-action="slept"]') as Element)
    fireEvent.click(document.querySelector('[data-action="cleaned"]') as Element)
    fireEvent.click(document.querySelector('[data-action="treated"]') as Element)
    expect(h.onSleep).toHaveBeenCalledTimes(1)
    expect(h.onClean).toHaveBeenCalledTimes(1)
    expect(h.onTreat).toHaveBeenCalledTimes(1)
  })

  it("starts a cooldown after an action and re-enables when it elapses", () => {
    jest.useFakeTimers()
    try {
      const h = setup()
      const sleepBtn = document.querySelector('[data-action="slept"]') as HTMLButtonElement
      fireEvent.click(sleepBtn)
      expect(h.onSleep).toHaveBeenCalledTimes(1)
      // Cooling: disabled, shows a whole-seconds countdown, clicks ignored.
      expect(sleepBtn).toBeDisabled()
      expect(screen.getByTestId("pet-cooldown-slept").textContent).toMatch(/^\d+$/)
      fireEvent.click(sleepBtn)
      expect(h.onSleep).toHaveBeenCalledTimes(1)
      // Elapse the 5s sleep cooldown (ticker runs every 250ms).
      act(() => {
        jest.advanceTimersByTime(5500)
      })
      expect(sleepBtn).not.toBeDisabled()
    } finally {
      jest.useRealTimers()
    }
  })
})
