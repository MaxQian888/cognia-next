/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { EffortPreferencesCard } from "./effort-preferences-card"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AppSettings } from "@cognia/agent-config-types"

const save = jest.fn(async () => undefined)

function mount(settings: Partial<AppSettings> = {}) {
  useSettingsStore.setState({ settings: settings as AppSettings, save } as never)
  return render(<EffortPreferencesCard />)
}

beforeEach(() => {
  save.mockClear()
})

describe("default tier for new chats", () => {
  it("reads 'Auto' when nothing is configured", () => {
    mount()
    expect(screen.getByLabelText("Default for new chats")).toHaveTextContent("Auto")
  })

  it("reflects a stored default by its display name", () => {
    mount({ defaultThinkingLevel: "xhigh" })
    expect(screen.getByLabelText("Default for new chats")).toHaveTextContent("Extra")
  })

  it("offers the whole ladder, Auto and Ultracode included", () => {
    mount()
    // Radix Select opens on Enter without needing a pointer stack, which jsdom
    // does not provide.
    fireEvent.keyDown(screen.getByLabelText("Default for new chats"), { key: "Enter" })
    const options = screen.getAllByRole("option").map((el) => el.textContent ?? "")
    expect(options).toEqual(["Auto", "Low", "Medium", "High", "Extra", "Max", "Ultracode"])
  })

  it("stores an explicitly chosen tier", () => {
    mount()
    fireEvent.keyDown(screen.getByLabelText("Default for new chats"), { key: "Enter" })
    fireEvent.click(screen.getByRole("option", { name: "Ultracode" }))
    expect(save).toHaveBeenCalledWith({ defaultThinkingLevel: "ultracode" })
  })

  it("stores 'off' as a value rather than clearing the preference", () => {
    // "I deliberately want no default" has to survive a later change to what an
    // absent value means.
    mount({ defaultThinkingLevel: "high" })
    fireEvent.keyDown(screen.getByLabelText("Default for new chats"), { key: "Enter" })
    fireEvent.click(screen.getByRole("option", { name: "Auto" }))
    expect(save).toHaveBeenCalledWith({ defaultThinkingLevel: "off" })
  })
})

describe("tier visibility", () => {
  it("shows every tier as visible when nothing is hidden", () => {
    mount()
    for (const tier of ["low", "medium", "high", "xhigh", "max", "ultracode"]) {
      expect(screen.getByTestId(`effort-tier-toggle-${tier}`)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    }
  })

  it("marks a stored hidden tier as unchecked", () => {
    mount({ composerBehavior: { hiddenEffortTiers: ["max"] } })
    expect(screen.getByTestId("effort-tier-toggle-max")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("effort-tier-toggle-high")).toHaveAttribute("aria-checked", "true")
  })

  it("hides a tier on click", () => {
    mount()
    fireEvent.click(screen.getByTestId("effort-tier-toggle-low"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { hiddenEffortTiers: ["low"] } })
  })

  it("un-hides a tier on a second click", () => {
    mount({ composerBehavior: { hiddenEffortTiers: ["low", "max"] } })
    fireEvent.click(screen.getByTestId("effort-tier-toggle-low"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { hiddenEffortTiers: ["max"] } })
  })

  it("preserves the rest of the composer-behavior block", () => {
    // The block is written whole, so a careless spread would silently reset
    // every other composer preference.
    mount({ composerBehavior: { sendOnEnter: false, effortSelectorMode: "list" } })
    fireEvent.click(screen.getByTestId("effort-tier-toggle-max"))
    expect(save).toHaveBeenCalledWith({
      composerBehavior: {
        sendOnEnter: false,
        effortSelectorMode: "list",
        hiddenEffortTiers: ["max"],
      },
    })
  })

  it("refuses the click that would hide the last remaining tier", () => {
    // An empty ladder unmounts the composer control, which is the only surface
    // that could undo the preference — so the store never records one.
    mount({
      composerBehavior: { hiddenEffortTiers: ["low", "medium", "high", "xhigh", "max"] },
    })
    fireEvent.click(screen.getByTestId("effort-tier-toggle-ultracode"))
    expect(save).not.toHaveBeenCalled()
  })
})
