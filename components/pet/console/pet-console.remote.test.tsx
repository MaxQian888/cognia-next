// The /pet console on a paired phone, caring for the DESKTOP's pet (ADR-0219).
//
// Pins the two properties remote care rests on:
//   1. every action goes to the desktop as a `pet_*` call, and nothing on this
//      device emits on the pet bus or writes its pet tables (they are a mirror,
//      and there is no controller here to hear an event);
//   2. what only the desktop can do is labelled, not hidden or broken: the
//      desktop-only tabs are badged and render the notice, the binding tab is
//      read-only, the desktop toggle is a status chip (CLAUDE.md rule 7).

import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react"
import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isConnectionNoticeClaimed } from "@/lib/runtime/connection-notice-claim"

const render = (ui: ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options })

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
// Read lazily so one test can resolve the console to an outdated host.
let mockConsoleMode: { mode: string; reason?: string } = { mode: "remote" }
jest.mock("@/hooks/pet/use-pet-console-mode", () => ({
  usePetConsoleMode: () => mockConsoleMode,
}))
jest.mock("@/hooks/pet/use-active-character-id", () => ({ useActiveCharacterId: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "mobile" }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({
    target: { id: "m", kind: "companion", hostKind: "desktop", platform: "mobile" },
    vaultState: "unlocked",
    connectionState: "online",
    host: { compatible: true, operations: ["pet_get"], grants: [] },
  }),
}))
jest.mock("@/hooks/pet/use-pet")
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: { settings: unknown }) => unknown) =>
    // This device's own pet settings ask for a Live2D skin with low power
    // off; a remote console must ignore both.
    select({ settings: { petSettings: { skinId: "live2d", lowPower: false } } }),
}))

// The desktop, as the phone reaches it.
jest.mock("@/lib/pet/remote/live-transport", () => {
  const client = {
    getSnapshot: jest.fn(),
    act: jest.fn(),
    purchase: jest.fn(),
    applyDecor: jest.fn(),
    rename: jest.fn(),
    hatch: jest.fn(),
    sendChat: jest.fn(),
    listChat: jest.fn(),
    clearChat: jest.fn(),
  }
  return {
    livePetRemoteClient: () => client,
    subscribeLivePetTransport: () => () => undefined,
    __client: client,
  }
})
jest.mock("@/lib/sync/companion-sync", () => ({
  ...jest.requireActual("@/lib/sync/companion-sync"),
  runSyncDown: jest.fn().mockResolvedValue([]),
}))

// Everything a LOCAL console would call. Remote care must call none of it.
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  ...jest.requireActual("@/lib/pet/events/pet-event-bus"),
  emitPetEvent: jest.fn(),
}))
jest.mock("@/lib/pet/economy/shop", () => ({
  ...jest.requireActual("@/lib/pet/economy/shop"),
  purchaseItem: jest.fn(),
  consumeItem: jest.fn(),
}))
jest.mock("@/lib/pet/runtime/hatch", () => ({ hatchPetOnce: jest.fn() }))
jest.mock("@/lib/pet/runtime/rename-pet", () => ({
  ...jest.requireActual("@/lib/pet/runtime/rename-pet"),
  renamePet: jest.fn(),
}))
jest.mock("@/lib/pet/commands", () => ({ toggleDesktopPetWindow: jest.fn() }))
jest.mock("@/lib/pet/settings-sync", () => ({ updatePetSettings: jest.fn() }))
jest.mock("@/hooks/pet/use-pet-chat", () => ({
  ...jest.requireActual("@/hooks/pet/use-pet-chat"),
  usePetChat: jest.fn(),
}))

const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: unknown) => {
    rendererProps(props)
    return <div data-testid="pet-renderer-stub" />
  },
}))
// Tabs whose own suites cover them; here only whether they mount.
jest.mock("./customize-tab", () => ({ CustomizeTab: () => <div data-testid="tab-customize" /> }))
jest.mock("./insights-tab", () => ({ InsightsTab: () => <div data-testid="tab-insights" /> }))
jest.mock("./journal-tab", () => ({ JournalTab: () => <div data-testid="tab-journal" /> }))
jest.mock("./dex-tab", () => ({ DexTab: () => <div data-testid="tab-dex" /> }))
jest.mock("./achievements-tab", () => ({ AchievementsTab: () => <div data-testid="tab-ach" /> }))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  usePluginSlotHasExtensions: () => false,
  PluginExtensionSlot: () => null,
}))

// The mirror: the desktop's pet tables as the phone last pulled them.
let mockMirrorProfile: unknown = undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown, _deps?: unknown, initial?: unknown) => {
    const src = String(fn)
    if (src.includes("listPetBindingsWithCharacters")) {
      return { characters: [{ id: "c1", name: "Ada" }], bindings: [] }
    }
    if (src.includes("listPetInventory")) return [{ id: "berry", qty: 2, updatedAt: "" }]
    if (src.includes("getPetProfile")) return mockMirrorProfile ?? null
    if (src.includes("petProfile")) return mockMirrorProfile
    return initial ?? []
  },
}))

import { toast } from "sonner"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetChat } from "@/hooks/pet/use-pet-chat"
import * as liveTransport from "@/lib/pet/remote/live-transport"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { hatchPetOnce } from "@/lib/pet/runtime/hatch"
import { renamePet } from "@/lib/pet/runtime/rename-pet"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import { updatePetSettings } from "@/lib/pet/settings-sync"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"
import type { PetProfile } from "@/types/pet"
import { PetConsole } from "./pet-console"

const client = (liveTransport as unknown as { __client: Record<string, jest.Mock> }).__client
const mockUsePet = usePet as jest.Mock

const local = {
  feed: jest.fn(),
  play: jest.fn(),
  petStroke: jest.fn(),
  talk: jest.fn(),
  sleep: jest.fn(),
  clean: jest.fn(),
  treat: jest.fn(),
}

function mirror(hatched: boolean) {
  const profile: PetProfile = {
    ...createDefaultProfile("companion-mirror", 0),
    soul: hatched ? { name: "Boba", personality: "x", hatchDate: "" } : null,
    stage: hatched ? "baby" : "egg",
    coins: 40,
  }
  mockMirrorProfile = profile
  mockUsePet.mockReturnValue({
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    binding: undefined,
    ...local,
  })
}

function snapshot(over: Partial<PetRemoteSnapshot> = {}): PetRemoteSnapshot {
  return {
    availability: { available: true },
    summary: {
      hatched: true,
      name: "Boba",
      level: 1,
      stage: "baby",
      xp: 0,
      mood: "happy",
      needs: { energy: 50, mood: 50, bond: 50 },
      condition: "well",
      coins: 40,
      streak: { days: 0, lastDay: null, multiplier: 1 },
      cooldowns: { fed: 0, played: 60_000 },
    },
    presentation: {
      requestedSkinId: "live2d",
      desktopVisible: true,
      llmSpeakEnabled: true,
      chatEnabled: true,
    },
    hostTime: 1,
    ...over,
  }
}

const clickTab = (id: string) =>
  fireEvent.mouseDown(document.querySelector(`[data-tab="${id}"]`) as Element)

async function renderRemote(initialTab?: "shop" | "binding") {
  render(<PetConsole initialTab={initialTab} />)
  await waitFor(() =>
    expect(screen.getByTestId("pet-remote-status-band")).toHaveAttribute("data-state", "info")
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockConsoleMode = { mode: "remote" }
  for (const fn of Object.values(local)) fn.mockReset()
  client.getSnapshot.mockResolvedValue(snapshot())
  client.listChat.mockResolvedValue({ items: [] })
  client.act.mockResolvedValue({ ok: true, grantedXp: 3, grantedCoins: 1 })
  client.purchase.mockResolvedValue({ ok: true, coins: 35 })
  client.rename.mockResolvedValue({ ok: true, name: "Mochi" })
  client.hatch.mockResolvedValue({ ok: true, state: "pending" })
  mirror(true)
})

afterEach(() => {
  // The never-local pin, for every test in this file.
  expect(emitPetEvent).not.toHaveBeenCalled()
  expect(purchaseItem).not.toHaveBeenCalled()
  expect(consumeItem).not.toHaveBeenCalled()
  expect(hatchPetOnce).not.toHaveBeenCalled()
  expect(renamePet).not.toHaveBeenCalled()
  expect(toggleDesktopPetWindow).not.toHaveBeenCalled()
  expect(updatePetSettings).not.toHaveBeenCalled()
  expect(usePetChat).not.toHaveBeenCalled()
  for (const fn of Object.values(local)) expect(fn).not.toHaveBeenCalled()
})

describe("PetConsole remote care", () => {
  it("paints the desktop's pet from the mirror, with the desktop's state", async () => {
    await renderRemote()
    expect(screen.getByTestId("pet-console")).toHaveAttribute("data-mode", "remote")
    expect(screen.getByTestId("pet-remote-status-band")).toHaveTextContent(
      "Caring for your desktop pet"
    )
    // Only the desktop sends the pet out: a chip, not a toggle.
    expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()
    expect(screen.getByTestId("pet-console-desktop-status")).toHaveTextContent("On your desktop")
  })

  it("draws the plain vector pet in low power, with a neutral note for the desktop's skin", async () => {
    await renderRemote()
    expect(rendererProps).toHaveBeenCalled()
    for (const [props] of rendererProps.mock.calls) {
      expect(props).toMatchObject({ skinId: "svg", lowPower: true })
    }
    expect(screen.getByTestId("pet-console-simplified-look")).toBeInTheDocument()
    // No skin retry: the band's connection retry is the only one.
    expect(
      within(screen.getByTestId("pet-console-header")).queryByRole("button", { name: /retry/i })
    ).toBeNull()
  })

  it("sends care to the desktop and tells the reward", async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="fed"]') as Element)
    })
    expect(client.act).toHaveBeenCalledWith("fed", {})
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("+3 XP"))
  })

  it("greys an action that is cooling down on the desktop's clock", async () => {
    await renderRemote()
    expect(document.querySelector('[data-action="played"]')).toBeDisabled()
    expect(document.querySelector('[data-action="fed"]')).not.toBeDisabled()
  })

  it("makes talk a direct care action rather than a composer", async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/^talk$/i))
    })
    expect(client.act).toHaveBeenCalledWith("talked", {})
    expect(screen.queryByTestId("pet-talk-composer")).toBeNull()
  })

  it("buys and uses items in the desktop's shop", async () => {
    await renderRemote("shop")
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="buy-berry"]') as Element)
    })
    expect(client.purchase).toHaveBeenCalledWith("berry", 1)
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="use-berry"]') as Element)
    })
    expect(client.act).toHaveBeenCalledWith("fed", { itemId: "berry" })
  })

  it("renames the desktop's pet", async () => {
    await renderRemote()
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    const input = screen.getByLabelText(/pet name|pet\.rename\.label/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(client.rename).toHaveBeenCalledWith("Mochi")
  })

  it("hatches on the desktop and says the pet is on its way", async () => {
    mirror(false)
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^hatch$/i }))
    })
    expect(client.hatch).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  describe("what stays on the desktop (CLAUDE.md rule 7)", () => {
    it("badges the desktop-only tabs and keeps them in the nav", async () => {
      await renderRemote()
      const nav = screen.getByTestId("pet-console-nav")
      for (const tab of ["customize", "insights"]) {
        const trigger = nav.querySelector(`[data-tab="${tab}"]`) as HTMLElement
        expect(trigger).toHaveAttribute("data-desktop-only", "true")
        expect(within(trigger).getByTestId("pet-console-desktop-badge")).toBeInTheDocument()
      }
      for (const tab of ["nurture", "chat", "shop", "journal", "dex", "achievements", "binding"]) {
        expect(nav.querySelector(`[data-tab="${tab}"]`)).not.toHaveAttribute("data-desktop-only")
      }
    })

    it.each(["customize", "insights"])(
      "renders the notice for %s instead of its controls",
      async (tab) => {
        await renderRemote()
        clickTab(tab)
        expect(screen.getByTestId("pet-desktop-only-notice")).toHaveAttribute("data-tab", tab)
        expect(screen.queryByTestId(`tab-${tab}`)).toBeNull()
      }
    )

    it("shows the character bindings read-only", async () => {
      await renderRemote("binding")
      expect(screen.getByTestId("pet-binding")).toHaveAttribute("data-read-only")
      expect(screen.getByTestId("pet-binding-read-only")).toBeInTheDocument()
    })

    it("reads the journal, dex and achievements from the mirror", async () => {
      await renderRemote()
      clickTab("journal")
      expect(screen.getByTestId("tab-journal")).toBeInTheDocument()
      clickTab("dex")
      expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
      clickTab("achievements")
      expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    })
  })

  it("says the desktop has no pet yet instead of loading forever", async () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true, ...local })
    client.getSnapshot.mockResolvedValue(snapshot({ summary: null }))
    render(<PetConsole />)
    expect(await screen.findByTestId("pet-console-no-pet")).toBeInTheDocument()
  })

  it("waits for the mirror while the desktop's answer says a pet exists", async () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true, ...local })
    render(<PetConsole />)
    await waitFor(() => expect(client.getSnapshot).toHaveBeenCalled())
    expect(screen.getByTestId("pet-console-loading")).toBeInTheDocument()
    expect(screen.getByTestId("pet-remote-status-band")).toBeInTheDocument()
  })

  it("is the only report on a desktop too old to offer remote care", () => {
    // The surface boundary resolves such a host to read-only; its band would
    // repeat the update page above it unless the page claims the notice.
    mockConsoleMode = { mode: "unavailable", reason: "host-without-feature" }
    const { unmount } = render(<PetConsole />)
    expect(screen.getByTestId("pet-console-unavailable")).toHaveAttribute(
      "data-reason",
      "host-without-feature"
    )
    expect(isConnectionNoticeClaimed()).toBe(true)
    unmount()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })

  it("draws the console's skeleton while the paired host's manifest is pending", () => {
    // Paired, but the host has not said yet whether it shares its pet: an
    // "update your desktop" page here would flash and vanish on most loads.
    mockConsoleMode = { mode: "unavailable", reason: "host-pending" }
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("pet-console-unavailable")).not.toBeInTheDocument()
    // Nothing is asked of a host that has not said it can answer.
    expect(screen.queryByTestId("pet-remote-status-band")).not.toBeInTheDocument()
    expect(client.getSnapshot).not.toHaveBeenCalled()
  })

  it("sends a secondary desktop window to the main window, without a pairing remedy", () => {
    mockConsoleMode = { mode: "unavailable", reason: "secondary-window" }
    render(<PetConsole />)
    const page = screen.getByTestId("pet-console-unavailable")
    expect(page).toHaveAttribute("data-reason", "secondary-window")
    expect(page).toHaveTextContent("Desktop only")
    expect(page).toHaveTextContent(
      "The pet console opens in Cognia's main window. Switch to it to look after your pet."
    )
    expect(screen.queryByTestId("pet-console-pair")).not.toBeInTheDocument()
    expect(within(page).getByRole("link", { name: "Back to chat" })).toHaveAttribute("href", "/")
    // Only the outdated-host page owns the connection report.
    expect(isConnectionNoticeClaimed()).toBe(false)
  })
})
