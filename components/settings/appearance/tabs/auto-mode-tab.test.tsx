import { act, fireEvent, render, screen } from "@testing-library/react"
import { AutoModeTab } from "./auto-mode-tab"
import { DEFAULT_AUTOMODE, DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import type { AutoModeSettings, BackgroundSettings, Wallpaper } from "@/types/appearance"
import {
  __INTERNALS__ as CACHE,
  analysisCacheKey,
  writeCachedAnalysis,
} from "@/lib/appearance/wallpaper-analysis-cache"

const mockSave = jest.fn()
let mockAutoMode: AutoModeSettings = { ...DEFAULT_AUTOMODE }
let mockBackground: BackgroundSettings = { ...DEFAULT_BACKGROUND_SETTINGS }
const NIGHT: Wallpaper = {
  id: "wp_night",
  name: "night",
  kind: "color",
  source: { kind: "color", value: "#0b1020" },
  builtin: false,
  createdAt: 1,
}
const PAPER: Wallpaper = {
  ...NIGHT,
  id: "wp_paper",
  name: "paper",
  source: { kind: "color", value: "#f5f1e8" },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      autoMode: mockAutoMode,
      save: mockSave,
      background: mockBackground,
      wallpapers: [NIGHT, PAPER],
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

// Native <select> stand-in so onValueChange is fireable in jsdom.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  return {
    Select: ({ value, onValueChange, children }: never) =>
      React.createElement(
        "select",
        {
          value,
          onChange: (e: never) =>
            (onValueChange as (v: string) => void)((e as never)["target"]["value"]),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: never) => children,
    SelectItem: ({ value, children }: never) => React.createElement("option", { value }, children),
  }
})

function setAutoMode(patch: Partial<AutoModeSettings>) {
  mockAutoMode = { ...DEFAULT_AUTOMODE, ...patch }
}

beforeEach(() => {
  mockSave.mockClear()
  setAutoMode({})
  mockBackground = { ...DEFAULT_BACKGROUND_SETTINGS }
  localStorage.clear()
  CACHE.resetMemory()
})

describe("AutoModeTab", () => {
  it("toggles the enabled switch", () => {
    render(<AutoModeTab />)
    fireEvent.click(screen.getByRole("switch", { name: "enabledLabel" }))
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({ enabled: true }),
    })
  })

  it("changes the trigger", () => {
    render(<AutoModeTab />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "schedule" } })
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({ trigger: "schedule" }),
    })
  })

  it("shows schedule time inputs only for the schedule trigger", async () => {
    render(<AutoModeTab />)
    expect(screen.queryByLabelText("schedule.lightAt")).not.toBeInTheDocument()
    setAutoMode({ trigger: "schedule" })
    render(<AutoModeTab />)
    const lightAt = screen.getByLabelText("schedule.lightAt") as HTMLInputElement
    expect(lightAt.value).toBe("07:00")
    // Every segment edit fires a change; each used to be a save, and on a
    // paired phone a queued host update.
    fireEvent.change(lightAt, { target: { value: "08:00" } })
    fireEvent.change(lightAt, { target: { value: "08:30" } })
    expect(mockSave).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(lightAt)
    })
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        schedule: expect.objectContaining({ lightAt: "08:30" }),
      }),
    })
    const darkAt = screen.getByLabelText("schedule.darkAt")
    fireEvent.change(darkAt, { target: { value: "20:15" } })
    await act(async () => {
      fireEvent.keyDown(darkAt, { key: "Enter" })
    })
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({ schedule: expect.objectContaining({ darkAt: "20:15" }) }),
    })
  })

  it("reverts a cleared schedule time instead of saving it", async () => {
    setAutoMode({ trigger: "schedule" })
    render(<AutoModeTab />)
    const darkAt = screen.getByLabelText("schedule.darkAt") as HTMLInputElement
    fireEvent.change(darkAt, { target: { value: "" } })
    await act(async () => {
      fireEvent.blur(darkAt)
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(darkAt.value).toBe("19:00")
  })

  it("captures geolocation for the sunset trigger", () => {
    const getCurrentPosition = jest.fn((ok: (p: unknown) => void) =>
      ok({ coords: { latitude: 40.123456, longitude: -74.987654 } })
    )
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    })
    setAutoMode({ trigger: "sunset" })
    render(<AutoModeTab />)
    fireEvent.click(screen.getByRole("button", { name: /sunset.useLocation/ }))
    expect(getCurrentPosition).toHaveBeenCalled()
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        location: { latitude: 40.1235, longitude: -74.9877, source: "os" },
      }),
    })
  })

  it("edits sunset latitude / longitude manually (no prior location)", async () => {
    setAutoMode({ trigger: "sunset" })
    render(<AutoModeTab />)
    const lat = screen.getByLabelText("sunset.latitude")
    fireEvent.change(lat, { target: { value: "5" } })
    fireEvent.change(lat, { target: { value: "51.5" } })
    expect(mockSave).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(lat)
    })
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        location: { latitude: 51.5, longitude: 0, source: "manual" },
      }),
    })
    const lng = screen.getByLabelText("sunset.longitude")
    fireEvent.change(lng, { target: { value: "2.35" } })
    await act(async () => {
      fireEvent.keyDown(lng, { key: "Enter" })
    })
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        location: { latitude: 0, longitude: 2.35, source: "manual" },
      }),
    })
  })

  it("keeps the prior location when geolocation fails", () => {
    const getCurrentPosition = jest.fn((_ok: unknown, err: () => void) => err())
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    })
    setAutoMode({ trigger: "sunset" })
    render(<AutoModeTab />)
    fireEvent.click(screen.getByRole("button", { name: /sunset.useLocation/ }))
    expect(getCurrentPosition).toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("shows the current location and edits longitude", async () => {
    setAutoMode({
      trigger: "sunset",
      location: { latitude: 51.5, longitude: -0.12, source: "manual" },
    })
    render(<AutoModeTab />)
    expect(screen.getByText(/51\.5/)).toBeInTheDocument()
    const lng = screen.getByLabelText("sunset.longitude")
    fireEvent.change(lng, { target: { value: "2.35" } })
    await act(async () => {
      fireEvent.blur(lng)
    })
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        location: expect.objectContaining({ longitude: 2.35, latitude: 51.5, source: "manual" }),
      }),
    })
    const lat = screen.getByLabelText("sunset.latitude")
    fireEvent.change(lat, { target: { value: "48.8" } })
    await act(async () => {
      fireEvent.blur(lat)
    })
    expect(mockSave).toHaveBeenCalledWith({
      autoMode: expect.objectContaining({
        location: expect.objectContaining({ latitude: 48.8, longitude: -0.12, source: "manual" }),
      }),
    })
  })

  it("reverts an out-of-range or empty coordinate instead of saving it", async () => {
    setAutoMode({
      trigger: "sunset",
      location: { latitude: 51.5, longitude: -0.12, source: "manual" },
    })
    render(<AutoModeTab />)
    const lat = screen.getByLabelText("sunset.latitude") as HTMLInputElement
    fireEvent.change(lat, { target: { value: "95" } })
    await act(async () => {
      fireEvent.blur(lat)
    })
    // An emptied field (what a lone "-" reads as) used to save latitude 0.
    fireEvent.change(lat, { target: { value: "" } })
    await act(async () => {
      fireEvent.blur(lat)
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(lat.value).toBe("51.5")
  })

  it("disables the location button when geolocation is unavailable", () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true })
    setAutoMode({ trigger: "sunset" })
    render(<AutoModeTab />)
    expect(screen.getByRole("button", { name: /sunset.useLocation/ })).toBeDisabled()
    expect(screen.getByText("sunset.unavailable")).toBeInTheDocument()
  })
})

describe("AutoModeTab — follow wallpaper", () => {
  it("offers the wallpaper trigger", () => {
    render(<AutoModeTab />)
    expect(screen.getByRole("option", { name: "trigger.wallpaper" })).toBeInTheDocument()
  })

  it("says it follows the system while no wallpaper is on", () => {
    setAutoMode({ enabled: true, trigger: "wallpaper" })
    render(<AutoModeTab />)
    expect(screen.getByTestId("auto-wallpaper-status")).toHaveTextContent("wallpaper.noWallpaper")
  })

  it("says it is measuring until the wallpaper's analysis lands, then names the variant", () => {
    setAutoMode({ enabled: true, trigger: "wallpaper" })
    mockBackground = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "wp_night" }
    render(<AutoModeTab />)
    expect(screen.getByTestId("auto-wallpaper-status")).toHaveTextContent("wallpaper.measuring")
    act(() =>
      writeCachedAnalysis(analysisCacheKey(NIGHT), {
        accent: "#0b1020",
        secondary: "#0b1020",
        dominant: "#0b1020",
        averageLuminance: 0.05,
        luminanceSpread: 0,
        darkExtreme: "#0b1020",
        brightExtreme: "#0b1020",
        baseVariant: "dark",
      })
    )
    expect(screen.getByTestId("auto-wallpaper-status")).toHaveTextContent("wallpaper.suitsDark")
  })

  it("names light for a pale wallpaper", () => {
    setAutoMode({ enabled: true, trigger: "wallpaper" })
    mockBackground = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "wp_paper" }
    writeCachedAnalysis(analysisCacheKey(PAPER), {
      accent: "#f5f1e8",
      secondary: "#f5f1e8",
      dominant: "#f5f1e8",
      averageLuminance: 0.88,
      luminanceSpread: 0,
      darkExtreme: "#e3dccb",
      brightExtreme: "#fbf8f1",
      baseVariant: "light",
    })
    render(<AutoModeTab />)
    expect(screen.getByTestId("auto-wallpaper-status")).toHaveTextContent("wallpaper.suitsLight")
  })

  it("shows no wallpaper status under the other triggers", () => {
    setAutoMode({ enabled: true, trigger: "system" })
    render(<AutoModeTab />)
    expect(screen.queryByTestId("auto-wallpaper-status")).not.toBeInTheDocument()
  })
})
