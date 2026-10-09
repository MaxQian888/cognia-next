import {
  render as rtlRender,
  screen,
  within,
  fireEvent,
  act,
  type RenderOptions,
} from "@testing-library/react"
import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"

// The nav's icon rail wraps each tab in a tooltip; the app mounts the provider
// globally in `app/layout.tsx`.
const render = (ui: ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options })

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/pet/use-active-character-id", () => ({
  useActiveCharacterId: () => "char-1",
}))
const chatTabProps = jest.fn()
jest.mock("./chat-tab", () => ({
  ChatTab: (props: unknown) => {
    chatTabProps(props)
    return <div data-testid="tab-chat" />
  },
}))

const mockUsePlatform = jest.fn(() => "tauri")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockUsePlatform(),
}))

jest.mock("@/hooks/pet/use-pet")
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (s: (x: unknown) => unknown) => s({ settings: settingsValue }),
}))

// Live2D model probe — default: no model, core not ready → effective skin "svg".
const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: false as boolean | undefined,
}))
const useActiveSpritePack = jest.fn(() => ({
  packId: undefined as string | undefined,
  row: undefined as { id: string } | undefined,
}))
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: () => useActiveSpritePack(),
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Capture renderer props (also intercepts NurtureTab's hero renderer — same module).
const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: unknown) => {
    rendererProps(props)
    return <div data-testid="pet-renderer-stub" />
  },
}))
const hatchPetOnce = jest.fn()
const renamePet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/pet/runtime/hatch", () => ({
  hatchPetOnce: (settings: unknown) => hatchPetOnce(settings),
}))
jest.mock("@/lib/pet/runtime/rename-pet", () => ({
  renamePet: (name: string) => renamePet(name),
  sanitizePetName: (s: string) => s.trim(),
  isValidPetName: (s: string) => s.trim().length > 0,
  MAX_PET_NAME: 24,
}))
const toggleDesktopPetWindow = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/pet/commands", () => ({
  toggleDesktopPetWindow: () => toggleDesktopPetWindow(),
}))
jest.mock("./dex-tab", () => ({ DexTab: () => <div data-testid="tab-dex" /> }))
jest.mock("./shop-tab", () => ({ ShopTab: () => <div data-testid="tab-shop" /> }))

// Nurture tab's inventory strip reads Dexie reactively — keep it empty here.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

// Plugin slot host — controllable "has extensions" flag + a stub mount.
let hasPluginExtensions = false
const slotProps = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  usePluginSlotHasExtensions: () => hasPluginExtensions,
  PluginExtensionSlot: (props: unknown) => {
    slotProps(props)
    return <div data-testid="pet-plugin-slot" />
  },
}))
jest.mock("./achievements-tab", () => ({ AchievementsTab: () => <div data-testid="tab-ach" /> }))
jest.mock("./binding-tab", () => ({ BindingTab: () => <div data-testid="tab-bind" /> }))

import { toast } from "sonner"
import { usePet } from "@/hooks/pet/use-pet"
import { PetConsole } from "./pet-console"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"

const mockUsePet = usePet as jest.Mock

function petResult(soul: PetProfile["soul"]) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul,
    stage: soul ? "baby" : "egg",
  }
  return {
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
  }
}

beforeEach(() => {
  mockUsePlatform.mockReturnValue("tauri")
  resetPetSkinRuntimeForTests()
  mockUsePet.mockReset()
  hatchPetOnce.mockReset()
  hatchPetOnce.mockResolvedValue({ status: "hatched", profile: {} })
  renamePet.mockReset()
  renamePet.mockResolvedValue(undefined)
  chatTabProps.mockClear()
  ;(toast.error as jest.Mock).mockClear()
  rendererProps.mockClear()
  slotProps.mockClear()
  hasPluginExtensions = false
  settingsValue = {}
  toggleDesktopPetWindow.mockReset()
  toggleDesktopPetWindow.mockResolvedValue(true)
  useActiveLive2dModel.mockReset()
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  useActiveSpritePack.mockReset()
  useActiveSpritePack.mockReturnValue({ packId: undefined, row: undefined })
})

describe("PetConsole", () => {
  it("shows loading until the pet is ready", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toBeInTheDocument()
  })

  it("keeps the same hooks when the profile finishes loading after mount", () => {
    // The regression pin: the desktop toggle's state hook sat after the
    // loading return, so the first render with a profile threw "Rendered
    // more hooks than during the previous render".
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    const { rerender } = render(<PetConsole />)
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    rerender(<PetConsole />)
    expect(screen.getByTestId("pet-console")).toBeInTheDocument()
    expect(screen.getByTestId("pet-console-desktop-toggle")).toBeInTheDocument()
  })

  it("offers a hatch action for an unhatched egg, through the single-flight hatch", async () => {
    settingsValue = { defaultProvider: "openai" }
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-hatch")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(hatchPetOnce).toHaveBeenCalledWith({ defaultProvider: "openai" })
  })

  it("toasts a hatch that failed", async () => {
    hatchPetOnce.mockResolvedValue({ status: "failed", error: new Error("x") })
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(toast.error).toHaveBeenCalled()
  })

  it("reads the pet through the open session's character and names it in chat", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole initialTab="chat" />)
    expect(mockUsePet).toHaveBeenCalledWith("char-1")
    // The chat itself reads the character through the console's actions.
    expect(chatTabProps).toHaveBeenCalledWith({ petName: "Boba" })
  })

  it("runs in local mode on the desktop, with nothing labelled desktop-only", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console")).toHaveAttribute("data-mode", "local")
    expect(screen.queryByTestId("pet-console-desktop-badge")).toBeNull()
    expect(screen.queryByTestId("pet-remote-status-band")).toBeNull()
    expect(screen.queryByTestId("pet-console-desktop-status")).toBeNull()
  })

  it("shows the nurture layout for a hatched pet and switches tabs", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-nurture-tab")).toBeInTheDocument()
    // Radix tabs activate on mousedown (and on focus/keys), not on click.
    const clickTab = (id: string) =>
      fireEvent.mouseDown(document.querySelector(`[data-tab="${id}"]`) as Element)
    clickTab("shop")
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
    clickTab("dex")
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    clickTab("achievements")
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    clickTab("binding")
    expect(screen.getByTestId("tab-bind")).toBeInTheDocument()
  })

  it("renders one grouped tablist whose tabs control the content panel", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)

    const nav = screen.getByTestId("pet-console-nav")
    expect(nav).toHaveAttribute("role", "tablist")
    // The phone no longer goes through a hamburger Sheet.
    expect(screen.queryByTestId("pet-console-mobile-nav-trigger")).toBeNull()
    const nurture = within(nav).getByRole("tab", { name: /nurture/i })
    expect(nurture).toHaveAttribute("aria-selected", "true")
    const panel = screen.getByRole("tabpanel")
    expect(nurture).toHaveAttribute("aria-controls", panel.id)
    expect(panel).toContainElement(screen.getByTestId("pet-nurture-tab"))
    for (const group of ["nurture", "personalize", "records"]) {
      expect(nav.querySelector(`[data-nav-group="${group}"]`)).not.toBeNull()
    }
  })

  it("opens at the deep-linked initial tab and follows later deep links", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    const { rerender } = render(<PetConsole initialTab="dex" />)
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    rerender(<PetConsole initialTab="achievements" />)
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
  })

  it("jumps from the nurture wallet strip to the shop tab", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(screen.getByTestId("pet-wallet-strip"))
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
  })

  it("resolves the effective skin and passes it to the header renderer and nurture tab", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    // Header hero + nurture-tab hero both go through the mocked renderer.
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "live2d" }))
    expect(rendererProps).not.toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })

  it("falls back to the svg skin when the Live2D core is not ready", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
    // The header explains why the built-in mascot is showing.
    expect(screen.getByText(/requested skin.*live2d/i)).toBeInTheDocument()
    expect(screen.getByText(/effective skin.*vector mascot/i)).toBeInTheDocument()
  })

  it("omits the fallback note once Live2D renders", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    expect(screen.queryByText(/fallback is active/i)).toBeNull()
  })

  it("offers a functional retry after repeated WebGL context loss", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    const runtime = getPetSkinRuntime()
    runtime.recordContextLoss("live2d:m1")
    runtime.recordContextLoss("live2d:m1")

    render(<PetConsole />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()
  })

  it("offers the same runtime recovery for an active Sprite v2 pack", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveSpritePack.mockReturnValue({ packId: "s1", row: { id: "s1" } })
    settingsValue = { petSettings: { skinId: "sprite-v2" } }
    const runtime = getPetSkinRuntime()
    runtime.recordAssetFailure("sprite-v2:s1", "renderFailed")

    render(<PetConsole />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("sprite-v2:s1")).toBeUndefined()
  })

  it("hides the plugins tab until a pet.console.tab extension registers", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(document.querySelector('[data-tab="plugins"]')).toBeNull()
  })

  it("shows the plugins tab and mounts the slot with the safe context bag", () => {
    hasPluginExtensions = true
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.mouseDown(document.querySelector('[data-tab="plugins"]') as Element)
    expect(screen.getByTestId("pet-plugin-slot")).toBeInTheDocument()
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({
        point: "pet.console.tab",
        context: expect.objectContaining({
          level: expect.any(Number),
          stage: "baby",
          mood: expect.any(String),
          condition: expect.any(String),
        }),
      })
    )
  })

  it("falls back to nurture for a plugins deep link with no plugin tab yet", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole initialTab="plugins" />)
    expect(screen.getByTestId("pet-nurture-tab")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-plugin-slot")).toBeNull()
  })

  it("shows a layout-matched placeholder while the profile loads", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("renames the pet from the header editor", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    const input = screen.getByLabelText(/pet name|pet\.rename\.label/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(renamePet).toHaveBeenCalledWith("Mochi")
  })
})

describe("hosts where the pet cannot run", () => {
  it.each(["web", "mobile"])(
    "asks an unpaired %s client to pair instead of spinning forever",
    (platform) => {
      // The surface contract lists /pet as a navigable route, and `PetMount`
      // refuses to initialize the profile on the Capacitor shell, so a phone
      // reaching this page used to wait at a spinner that never resolved.
      mockUsePlatform.mockReturnValue(platform)
      mockUsePet.mockReturnValue(petResult(null))
      render(<PetConsole />)
      const unavailable = screen.getByTestId("pet-console-unavailable")
      expect(unavailable).toHaveAttribute("data-reason", "unpaired")
      expect(unavailable).toHaveTextContent("Pair with your desktop")
      expect(screen.queryByTestId("pet-console-loading")).not.toBeInTheDocument()
    }
  )

  it("gives the unavailable page the pairing remedy and a way out", () => {
    mockUsePlatform.mockReturnValue("mobile")
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    const links = within(screen.getByTestId("pet-console-unavailable")).getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/pair", "/"])
  })

  it("renders the console normally on a host that does run the pet", () => {
    mockUsePlatform.mockReturnValue("tauri")
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.queryByTestId("pet-console-unavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("pet-console")).toBeInTheDocument()
  })
})

describe("desktop toggle in the console header", () => {
  const hatched = () =>
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))

  it("offers to send a hatched pet out to the desktop", async () => {
    hatched()
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(within(button).getAllByText(/Show desktop pet|quickMenu\.showDesktopPet/).length).toBe(2)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1)
  })

  it("offers to call the pet back while it is on the desktop", () => {
    hatched()
    settingsValue = { petSettings: { enabled: true, desktopPet: { enabled: true } } }
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(within(button).getAllByText(/Hide desktop pet|quickMenu\.hideDesktopPet/).length).toBe(2)
  })

  it("disables itself while a toggle is in flight", async () => {
    hatched()
    let resolve!: (v: boolean) => void
    toggleDesktopPetWindow.mockReturnValueOnce(new Promise<boolean>((r) => (resolve = r)))
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()
    await act(async () => {
      resolve(true)
    })
    expect(button).not.toBeDisabled()
  })

  it("says so when the desktop pet would not open", async () => {
    hatched()
    toggleDesktopPetWindow.mockResolvedValueOnce(false)
    render(<PetConsole />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pet-console-desktop-toggle"))
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it("recovers from a toggle that throws instead of staying disabled", async () => {
    hatched()
    toggleDesktopPetWindow.mockRejectedValueOnce(new Error("ipc"))
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(button).not.toBeDisabled()
  })

  it("is not offered for an unhatched egg", () => {
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()
  })
})
