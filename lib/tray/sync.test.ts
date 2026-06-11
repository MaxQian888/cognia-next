import { renderHook, act } from "@testing-library/react"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}))
// next-intl is globally mocked in jest.setup.ts (key-resolving translator backed by
// i18n/messages/en.json). No inline override needed here.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(_query: () => T, _deps: unknown[], def: T) => def,
}))
jest.mock("@/lib/db/goals", () => ({
  getOpenGoalForSession: jest.fn().mockResolvedValue(undefined),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }

import {
  useSyncTrayToRust,
  defaultSnapshot,
  getTrayTooltipFromRust,
  makeResilientTrayTranslator,
  type NextIntlTranslator,
} from "./sync"
import { useTrayStore, __resetTrayStoreForTesting } from "./store"
import { __resetTrayRegistryForTesting, registerTrayItem } from "./registry"
import { DEFAULT_TRAY_ITEMS } from "./defaults"

beforeEach(() => {
  jest.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  __resetTrayStoreForTesting()
  __resetTrayRegistryForTesting()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("defaultSnapshot", () => {
  it("returns a snapshot with goal/automation/chat/platform shape", () => {
    const snap = defaultSnapshot()
    expect(snap.goal).toEqual({ active: false, paused: false })
    expect(snap.automation).toEqual({ running: false, armed: true })
    expect(snap.chat).toEqual({ streaming: false, hasActiveSession: false })
    expect(snap.platform.os).toBeDefined()
  })
})

describe("useSyncTrayToRust", () => {
  it("does not push until the store is hydrated", () => {
    renderHook(() => useSyncTrayToRust())
    act(() => {
      jest.advanceTimersByTime(500)
    })
    // The state snapshot probes OS autostart on mount (an unrelated read);
    // what must NOT happen before hydration is any tray_* push.
    const trayPushes = invoke.mock.calls.filter((c) => String(c[0]).startsWith("tray_"))
    expect(trayPushes).toHaveLength(0)
  })

  it("debounces menu pushes — back-to-back updates produce a single invoke", () => {
    useTrayStore.setState({ items: DEFAULT_TRAY_ITEMS, hydrated: true })
    renderHook(() => useSyncTrayToRust())

    // Flush the debounce from the initial schedule.
    act(() => {
      jest.advanceTimersByTime(200)
    })
    const initialCalls = invoke.mock.calls.filter((c) => c[0] === "tray_set_menu").length

    // Burst: 3 plugin-registry mutations within the debounce window.
    act(() => {
      registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
      registerTrayItem({ id: "p:b", pluginId: "p", label: "B" })
      registerTrayItem({ id: "p:c", pluginId: "p", label: "C" })
    })
    act(() => {
      jest.advanceTimersByTime(200)
    })
    const afterBurst = invoke.mock.calls.filter((c) => c[0] === "tray_set_menu").length

    // Each registerTrayItem fires the subscriber once; the debouncer must
    // coalesce them. So we expect ONE additional push, not three.
    expect(afterBurst - initialCalls).toBeLessThanOrEqual(1)
  })

  it("resolves tray labels via the root translator (not a `tray`-scoped one)", () => {
    // Regression: the hook used to call `useTranslations(\"tray\")`, which
    // turned the `tray.show` key in DEFAULT_TRAY_ITEMS into a lookup against
    // `tray.tray.show` and logged a MISSING_MESSAGE warning at every flush.
    useTrayStore.setState({ items: DEFAULT_TRAY_ITEMS, hydrated: true })
    renderHook(() => useSyncTrayToRust())
    act(() => {
      jest.advanceTimersByTime(200)
    })
    const menuCall = invoke.mock.calls.find((c) => c[0] === "tray_set_menu")
    expect(menuCall).toBeDefined()
    const dto = (menuCall![1] as { items: Array<{ id: string; label: string }> }).items
    const showItem = dto.find((d) => d.id === "tray.show")
    expect(showItem?.label).toBe("Show / hide window")
    // Must not have leaked the raw key through. Separators have no label.
    for (const item of dto) {
      if (typeof item.label !== "string") continue
      expect(item.label.startsWith("tray.")).toBe(false)
    }
  })

  it("pushes tray_set_icon_state when iconState changes", () => {
    useTrayStore.setState({ items: DEFAULT_TRAY_ITEMS, hydrated: true })
    renderHook(() => useSyncTrayToRust())
    act(() => {
      jest.advanceTimersByTime(200)
    })
    invoke.mockClear()
    act(() => {
      useTrayStore.getState().setIconState("busy")
    })
    expect(invoke).toHaveBeenCalledWith("tray_set_icon_state", { state: "busy" })
  })

  it("pushes tray_set_tooltip when tooltip changes", () => {
    useTrayStore.setState({ items: DEFAULT_TRAY_ITEMS, hydrated: true })
    renderHook(() => useSyncTrayToRust())
    act(() => {
      jest.advanceTimersByTime(200)
    })
    invoke.mockClear()
    act(() => {
      useTrayStore.getState().setTooltip("Cognia (busy)")
    })
    expect(invoke).toHaveBeenCalledWith("tray_set_tooltip", {
      text: "Cognia (busy)",
    })
  })
})

describe("makeResilientTrayTranslator", () => {
  // Production next-intl throws `MISSING_MESSAGE` when a key is missing.
  // The global jest mock in `jest.setup.ts` is lenient and returns the key
  // verbatim, which masks the bug — so this test uses a strict synthetic
  // translator that matches production behaviour.
  function strictTranslator(known: Record<string, string>): NextIntlTranslator {
    const t = ((key: string) => {
      if (key in known) return known[key]
      throw new Error(`MISSING_MESSAGE: Could not resolve '${key}'`)
    }) as NextIntlTranslator
    t.has = (key: string) => key in known
    return t
  }

  it("returns the translation for known i18n keys", () => {
    const resilient = makeResilientTrayTranslator(
      strictTranslator({ "tray.show": "Show Cognia", "tray.newChat": "New Chat" })
    )
    expect(resilient("tray.show")).toBe("Show Cognia")
    expect(resilient("tray.newChat")).toBe("New Chat")
  })

  it("returns the key verbatim for unknown labels (slash names, plugin labels)", () => {
    const resilient = makeResilientTrayTranslator(strictTranslator({ "tray.show": "Show Cognia" }))
    // Regression: `/clear` flowed in from `all-commands.ts` as a literal slash
    // label. Without the resilient wrapper, the builder's `t("/clear")` call
    // crashed the tray rebuild under production next-intl
    // (`MISSING_MESSAGE: Could not resolve '/clear' in messages for locale 'zh-CN'`).
    expect(resilient("/clear")).toBe("/clear")
    expect(resilient("/goal")).toBe("/goal")
    // Plugin tray items pass arbitrary display strings as `label`.
    expect(resilient("My Plugin Action")).toBe("My Plugin Action")
    // Command titles from `lib/plugin/commands/registry.ts` likewise.
    expect(resilient("git.status")).toBe("git.status")
  })

  it("does not throw even when every label is unknown", () => {
    const resilient = makeResilientTrayTranslator(strictTranslator({}))
    expect(() => resilient("/clear")).not.toThrow()
    expect(() => resilient("anything")).not.toThrow()
  })
})

describe("getTrayTooltipFromRust", () => {
  it("returns the tooltip string Rust reports", async () => {
    invoke.mockResolvedValueOnce("Cognia (idle)")
    const tooltip = await getTrayTooltipFromRust()
    expect(invoke).toHaveBeenCalledWith("tray_get_tooltip")
    expect(tooltip).toBe("Cognia (idle)")
  })

  it("returns null when Rust has no tooltip stored", async () => {
    invoke.mockResolvedValueOnce(null)
    const tooltip = await getTrayTooltipFromRust()
    expect(tooltip).toBeNull()
  })

  it("coerces non-string responses to null (defensive)", async () => {
    invoke.mockResolvedValueOnce(42 as unknown)
    const tooltip = await getTrayTooltipFromRust()
    expect(tooltip).toBeNull()
  })

  it("returns null when the IPC layer rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("not managed"))
    const tooltip = await getTrayTooltipFromRust()
    expect(tooltip).toBeNull()
  })
})
