/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { DailyWallpaperCard } from "./daily-wallpaper-card"
import {
  DEFAULT_DAILY_WALLPAPER,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
  useFormatter: () => ({ relativeTime: () => "just now" }),
}))

function renderCard(patch: Partial<DailyWallpaperSettings> = {}) {
  const onChange = jest.fn()
  const onFetchNow = jest.fn(async () => {})
  render(
    <DailyWallpaperCard
      daily={{ ...DEFAULT_DAILY_WALLPAPER, enabled: true, ...patch }}
      onChange={onChange}
      onFetchNow={onFetchNow}
    />
  )
  return { onChange, onFetchNow }
}

describe("DailyWallpaperCard", () => {
  it("toggles the feature", () => {
    const { onChange } = renderCard({ enabled: false })
    fireEvent.click(screen.getByTestId("daily-enable"))
    expect(onChange).toHaveBeenCalledWith({ enabled: true })
  })

  it("states the network implication up front rather than in a tooltip", () => {
    // This is the only appearance setting that contacts a third party, and the
    // notice is standing text so it cannot be missed.
    renderCard()
    expect(screen.getByText(/networkNotice/)).toBeInTheDocument()
  })

  it("shows only the selected provider's options", () => {
    renderCard({ providerId: "bing" })
    expect(screen.getByTestId("daily-bing-options")).toBeInTheDocument()
    expect(screen.queryByTestId("daily-nasa-options")).not.toBeInTheDocument()
    expect(screen.queryByTestId("daily-custom-options")).not.toBeInTheDocument()
  })

  it("reveals the NASA options for that provider", () => {
    renderCard({ providerId: "nasaApod" })
    expect(screen.getByTestId("daily-nasa-options")).toBeInTheDocument()
    expect(screen.queryByTestId("daily-bing-options")).not.toBeInTheDocument()
  })

  it("keeps the api key out of a screenshot", () => {
    renderCard({ providerId: "nasaApod", nasaApod: { preferHd: false, apiKey: "secret" } })
    expect(screen.getByTestId("daily-nasa-key")).toHaveAttribute("type", "password")
  })

  it("forwards a NASA key edit without dropping the other option", () => {
    const { onChange } = renderCard({
      providerId: "nasaApod",
      nasaApod: { preferHd: true, apiKey: "" },
    })
    fireEvent.change(screen.getByTestId("daily-nasa-key"), { target: { value: "abc" } })
    expect(onChange).toHaveBeenCalledWith({ nasaApod: { preferHd: true, apiKey: "abc" } })
  })

  it("hides the JSON path fields when the URL is the image itself", () => {
    // Asking where the image URL sits inside a response that is not JSON is a
    // question with no answer.
    renderCard({
      providerId: "custom",
      custom: { url: "https://example.test/a.jpg", kind: "image" },
    })
    expect(screen.queryByTestId("daily-custom-image-path")).not.toBeInTheDocument()
  })

  it("shows the JSON path fields for a JSON source", () => {
    renderCard({
      providerId: "custom",
      custom: { url: "https://example.test/api", kind: "json" },
    })
    expect(screen.getByTestId("daily-custom-image-path")).toBeInTheDocument()
    expect(screen.getByTestId("daily-custom-base-url")).toBeInTheDocument()
  })

  it("merges a custom-source edit rather than replacing the object", () => {
    const { onChange } = renderCard({
      providerId: "custom",
      custom: { url: "https://example.test/api", kind: "json", titlePath: "t" },
    })
    fireEvent.change(screen.getByTestId("daily-custom-image-path"), {
      target: { value: "images.0.url" },
    })
    expect(onChange).toHaveBeenCalledWith({
      custom: {
        url: "https://example.test/api",
        kind: "json",
        titlePath: "t",
        imagePath: "images.0.url",
      },
    })
  })

  it("says nothing has been fetched yet", () => {
    renderCard({ lastFetchedAt: undefined })
    expect(screen.getByTestId("daily-status")).toHaveTextContent("neverFetched")
  })

  it("reports the last success", () => {
    renderCard({ lastFetchedAt: Date.now() })
    expect(screen.getByTestId("daily-status")).toHaveTextContent("lastFetched")
  })

  it("surfaces the last failure instead of leaving it silent", () => {
    // A daily wallpaper that quietly stopped working looks exactly like one
    // that was never switched on.
    renderCard({ lastError: { code: "rate-limited", at: Date.now() } })
    expect(screen.getByTestId("daily-status")).toHaveTextContent("error.rate-limited")
  })

  it("prefers the failure over a stale success", () => {
    renderCard({
      lastFetchedAt: Date.now() - 100_000,
      lastError: { code: "network", at: Date.now() },
    })
    expect(screen.getByTestId("daily-status")).toHaveTextContent("error.network")
    expect(screen.getByTestId("daily-status")).not.toHaveTextContent("lastFetched")
  })

  it("runs a manual fetch and reports progress", async () => {
    let release: (() => void) | undefined
    const onFetchNow = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    render(
      <DailyWallpaperCard
        daily={{ ...DEFAULT_DAILY_WALLPAPER, enabled: true }}
        onChange={jest.fn()}
        onFetchNow={onFetchNow}
      />
    )

    const button = screen.getByTestId("daily-fetch-now")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(onFetchNow).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent("fetching")

    await act(async () => {
      release?.()
    })
    expect(button).not.toBeDisabled()
  })

  it("re-enables the button after a failed manual fetch", async () => {
    // A rejected fetch must not leave the control stuck spinning.
    const onFetchNow = jest.fn(async () => {
      throw new Error("nope")
    })
    render(
      <DailyWallpaperCard
        daily={{ ...DEFAULT_DAILY_WALLPAPER, enabled: true }}
        onChange={jest.fn()}
        onFetchNow={onFetchNow}
      />
    )
    const button = screen.getByTestId("daily-fetch-now")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).not.toBeDisabled()
  })

  it("forwards the retention and apply toggles", () => {
    const { onChange } = renderCard({ autoApply: true, wifiOnly: true })
    fireEvent.click(screen.getByTestId("daily-auto-apply"))
    expect(onChange).toHaveBeenCalledWith({ autoApply: false })
    fireEvent.click(screen.getByTestId("daily-wifi-only"))
    expect(onChange).toHaveBeenCalledWith({ wifiOnly: false })
  })

  it("marks the section disabled so the runtime and the UI agree", () => {
    renderCard({ enabled: false })
    expect(screen.getByTestId("wallpaper-daily")).toHaveAttribute("data-enabled", "false")
  })
})
