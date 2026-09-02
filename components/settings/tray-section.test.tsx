import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TraySection } from "./tray-section"
import { __resetTrayStoreForTesting, useTrayStore } from "@/lib/tray/store"
import { __resetSlashCommandsForTesting, registerSlashCommand } from "@/lib/slash-commands/registry"
import { DEFAULT_TRAY_DISPLAY, DEFAULT_TRAY_ITEMS } from "@/lib/tray/defaults"

// The display card's usage feed hits the subscription transport when real —
// stub it (its own behavior is covered by lib/tray/usage.test.ts).
jest.mock("@/lib/tray/usage", () => ({
  useTrayUsage: jest.fn(() => ({
    accounts: [
      {
        key: "anthropic:a1",
        provider: "anthropic",
        accountLabel: "Claude Pro",
        worst: { id: "session", kind: "window", usedPct: 42, status: "ok", resetAt: null },
        meters: [],
      },
    ],
    fetchedAt: 1,
  })),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: { fallback?: string }) => vars?.fallback ?? key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  TAURI_EVENTS: {},
  onTauriEvent: () => Promise.resolve(() => {}),
}))

jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
  deletePref: jest.fn().mockResolvedValue(undefined),
  flushPrefs: jest.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  __resetTrayStoreForTesting()
  __resetSlashCommandsForTesting()
  useTrayStore.setState({ items: DEFAULT_TRAY_ITEMS, hydrated: true })
})

describe("TraySection", () => {
  it("renders every item from the store with its label", () => {
    render(<TraySection />)
    expect(screen.getByText("tray.toggleWindow")).toBeInTheDocument()
    expect(screen.getByText("tray.allCommands")).toBeInTheDocument()
    expect(screen.getByText("tray.quit")).toBeInTheDocument()
  })

  it("moveDown reorders adjacent rows", () => {
    render(<TraySection />)
    const idOf = () => useTrayStore.getState().items.map((i) => ("id" in i ? i.id : "(sep)"))
    const [first0, first1] = idOf()
    const downButtons = screen.getAllByLabelText("Move down")
    fireEvent.click(downButtons[0])
    const after = idOf()
    // The first two rows must have swapped, nothing else shifted.
    expect(after[0]).toBe(first1)
    expect(after[1]).toBe(first0)
  })

  it("remove drops the row from the store", () => {
    render(<TraySection />)
    const before = useTrayStore.getState().items.length
    const removeButtons = screen.getAllByLabelText("Remove")
    fireEvent.click(removeButtons[0])
    expect(useTrayStore.getState().items.length).toBe(before - 1)
  })

  it("reset restores the locked default layout", () => {
    useTrayStore.getState().setItems([])
    render(<TraySection />)
    fireEvent.click(screen.getByText("Reset"))
    expect(useTrayStore.getState().items).toEqual(DEFAULT_TRAY_ITEMS)
  })

  it("display card toggles persist through the tray store", async () => {
    const user = userEvent.setup()
    render(<TraySection />)
    expect(useTrayStore.getState().display).toEqual(DEFAULT_TRAY_DISPLAY)

    await user.click(screen.getByLabelText("showUsageInTooltip"))
    expect(useTrayStore.getState().display.showUsageInTooltip).toBe(true)

    await user.click(screen.getByLabelText("showUsageInMenu"))
    expect(useTrayStore.getState().display.showUsageInMenu).toBe(false)
  })

  it("shows the pinned-subscription picker only when a compact surface is on", async () => {
    const user = userEvent.setup()
    render(<TraySection />)
    expect(screen.queryByLabelText("pinnedSubscription")).not.toBeInTheDocument()
    await user.click(screen.getByLabelText("showUsageInTooltip"))
    expect(screen.getByLabelText("pinnedSubscription")).toBeInTheDocument()
  })

  it("icon color changes persist through the tray store", () => {
    render(<TraySection />)
    fireEvent.change(screen.getByLabelText("iconColor"), { target: { value: "#ff0000" } })
    expect(useTrayStore.getState().display.iconColor).toBe("#ff0000")
  })

  it("tooltip base text edits persist through the tray store", () => {
    render(<TraySection />)
    fireEvent.change(screen.getByLabelText("tooltipBase"), { target: { value: "My App" } })
    expect(useTrayStore.getState().tooltip).toBe("My App")
  })

  it("Add item picker exposes registered slash commands", async () => {
    registerSlashCommand({
      id: "clear",
      name: "clear",
      description: "Start a fresh chat",
      category: "chat",
      handler: () => ({}),
    })
    render(<TraySection />)
    fireEvent.click(screen.getByText("Add item"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("/clear")).toBeInTheDocument()
  })
})

describe("TraySection — usage glance dimensions (ADR-0165)", () => {
  beforeEach(() => {
    __resetTrayStoreForTesting()
  })

  it("renders a control for each of the three dimensions", () => {
    render(<TraySection />)
    expect(screen.getByLabelText("usageMetric")).toBeInTheDocument()
    expect(screen.getByLabelText("usagePeriod")).toBeInTheDocument()
    expect(screen.getByLabelText("usageScope")).toBeInTheDocument()
  })

  it("disables window and scope under the quota metric, rather than hiding them", () => {
    // Hiding would collapse "does not apply here" into "does not exist", and
    // the user would never learn that switching to spend unlocks them.
    useTrayStore.getState().setDisplay({ usageMetric: "quota" })
    render(<TraySection />)
    expect(screen.getByLabelText("usagePeriod")).toBeDisabled()
    expect(screen.getByLabelText("usageScope")).toBeDisabled()
  })

  it("enables window and scope once a spend metric is chosen", () => {
    useTrayStore.getState().setDisplay({ usageMetric: "spend" })
    render(<TraySection />)
    expect(screen.getByLabelText("usagePeriod")).toBeEnabled()
    expect(screen.getByLabelText("usageScope")).toBeEnabled()
  })

  it("starts on the pre-ADR-0165 behaviour: plan quota, this app only", () => {
    render(<TraySection />)
    expect(useTrayStore.getState().display.usageMetric).toBe("quota")
    expect(useTrayStore.getState().display.usageScope).toBe("cognia")
  })

  it("warns that the all-tools scope reads other agents' local files", () => {
    render(<TraySection />)
    expect(screen.getByText("usageScopeHint")).toBeInTheDocument()
  })
})
