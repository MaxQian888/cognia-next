import { fireEvent, render, screen, within } from "@testing-library/react"

let narrow = false
jest.mock("@/hooks/ui/use-media-query", () => ({ useIsNarrow: () => narrow }))
const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: { size?: number }) => {
    rendererProps(props)
    return <div data-testid="pet-renderer-stub" />
  },
}))

import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import { PetConsoleHeader, type PetConsoleHeaderProps } from "./pet-console-header"

function props(over: Partial<PetConsoleHeaderProps> = {}, soul = true): PetConsoleHeaderProps {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: soul ? { name: "Boba", personality: "x", hatchDate: "" } : null,
    stage: soul ? "baby" : "egg",
    level: 3,
    coins: 42,
  }
  return {
    profile,
    view: computePetView(profile, null, 0),
    requestedSkinId: "svg",
    effectiveSkinId: "svg" as const,
    selection: { skinId: "svg" },
    diagnostics: [],
    onRename: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  narrow = false
  rendererProps.mockClear()
})

describe("PetConsoleHeader", () => {
  it("shows the level, stage and coins on one meta line", () => {
    render(<PetConsoleHeader {...props()} />)
    const meta = screen.getByTestId("pet-console-meta")
    expect(meta).toHaveTextContent("Level 3")
    expect(meta).toHaveTextContent("Baby")
    expect(meta).toHaveTextContent("42 coins")
  })

  it("draws a 48px pet on a wide window and a 40px pet on a phone", () => {
    const { rerender } = render(<PetConsoleHeader {...props()} />)
    expect(rendererProps).toHaveBeenLastCalledWith(expect.objectContaining({ size: 48 }))
    narrow = true
    rerender(<PetConsoleHeader {...props()} />)
    expect(rendererProps).toHaveBeenLastCalledWith(expect.objectContaining({ size: 40 }))
  })

  it("renames through the provided action", () => {
    const onRename = jest.fn()
    render(<PetConsoleHeader {...props({ onRename })} />)
    fireEvent.click(screen.getByLabelText(/rename/i))
    const input = screen.getByLabelText(/pet name/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Mochi")
  })

  it("titles an egg instead of offering a name editor", () => {
    render(<PetConsoleHeader {...props({}, false)} />)
    expect(screen.getByRole("heading", { name: /your pet|console\.title/i })).toBeInTheDocument()
    expect(screen.getByTestId("pet-console-meta")).toHaveTextContent("Egg")
  })

  it("offers the desktop toggle only when given, reflecting state and progress", () => {
    const onToggle = jest.fn()
    const { rerender } = render(<PetConsoleHeader {...props()} />)
    expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()

    rerender(
      <PetConsoleHeader {...props({ desktop: { onDesktop: false, pending: false, onToggle } })} />
    )
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(within(button).getAllByText(/show desktop pet/i)).toHaveLength(2)
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(
      <PetConsoleHeader {...props({ desktop: { onDesktop: true, pending: true, onToggle } })} />
    )
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button).toBeDisabled()
    expect(within(button).getAllByText(/hide desktop pet/i)).toHaveLength(2)
  })

  it("gives the phone toggle a 44px target", () => {
    narrow = true
    render(
      <PetConsoleHeader
        {...props({ desktop: { onDesktop: false, pending: false, onToggle: jest.fn() } })}
      />
    )
    expect(screen.getByTestId("pet-console-desktop-toggle")).toHaveClass("size-11")
  })

  // Remote care (ADR-0219): only the desktop sends the pet out, and a skin
  // this device cannot draw is not a fault to retry or configure.
  describe("caring from a paired device", () => {
    it("shows whether the pet is out on the desktop as a read-only chip", () => {
      render(<PetConsoleHeader {...props({ desktopStatus: { visible: true } })} />)
      const chip = screen.getByTestId("pet-console-desktop-status")
      expect(chip).toHaveTextContent("On your desktop")
      expect(chip.tagName).not.toBe("BUTTON")
      expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()
    })

    it("says hidden when the pet is not out", () => {
      render(<PetConsoleHeader {...props({ desktopStatus: { visible: false } })} />)
      expect(screen.getByTestId("pet-console-desktop-status")).toHaveTextContent("Hidden")
    })

    it("notes the simplified look instead of the skin fallback warning", () => {
      render(
        <PetConsoleHeader
          {...props({
            requestedSkinId: "live2d",
            simplifiedLook: true,
            onRetrySkin: undefined,
            onConfigureSkin: undefined,
          })}
        />
      )
      expect(screen.getByTestId("pet-console-simplified-look")).toHaveTextContent(
        /Simplified look on this device/
      )
      expect(screen.queryByText(/requested skin/i)).toBeNull()
      expect(screen.queryByRole("button", { name: /retry/i })).toBeNull()
    })
  })
})
