import { render, screen, fireEvent, within } from "@testing-library/react"
import { TraySection } from "./tray-section"
import { __resetTrayStoreForTesting, useTrayStore } from "@/lib/tray/store"
import { __resetSlashCommandsForTesting, registerSlashCommand } from "@/lib/slash-commands/registry"
import { DEFAULT_TRAY_ITEMS } from "@/lib/tray/defaults"

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
