/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let testSettings: Record<string, unknown> = { ttsEnabled: true, ttsProvider: "removed-provider" }
const setters = {
  setTtsRate: jest.fn(async (_v: number) => undefined),
  setTtsPitch: jest.fn(async (_v: number) => undefined),
  setTtsVolume: jest.fn(async (_v: number) => undefined),
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: testSettings,
      save: jest.fn(),
      setTtsEnabled: jest.fn(),
      setTtsProvider: jest.fn(),
      setTtsAutoPlay: jest.fn(),
      ...setters,
    }),
}))

// Range input standing in for the Radix slider: `change` is one drag frame
// (`onValueChange`), `pointerUp` the release (`onValueCommit`).
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({
      value,
      onValueChange,
      onValueCommit,
      min,
      max,
      step,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement("input", {
        type: "range",
        role: "slider",
        "aria-label": rest["aria-label"],
        value: (value as number[])[0],
        min,
        max,
        step,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: number[]) => void)([Number(e.target.value)]),
        onPointerUp: (e: { currentTarget: { value: string } }) =>
          (onValueCommit as (v: number[]) => void)([Number(e.currentTarget.value)]),
      }),
  }
})

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => "web",
  isTauri: () => false,
  isCapacitor: () => false,
}))

jest.mock("./provider-config", () => ({
  PROVIDER_CONFIG_COMPONENTS: {
    system: () => <div>system-config</div>,
    openai: () => <div>openai-config</div>,
  },
}))

jest.mock("./test-tts-button", () => ({
  TestTtsButton: () => <button type="button">test-voice</button>,
}))

import { TtsCard } from "./tts-card"

it("normalizes an unknown persisted provider to system before rendering", () => {
  testSettings = { ttsEnabled: true, ttsProvider: "removed-provider" }
  render(<TtsCard />)
  expect(screen.getByText("system-config")).toBeInTheDocument()
})

it("warns that pure-web cloud calls expose browser CORS and key risks", () => {
  testSettings = { ttsEnabled: true, ttsProvider: "openai" }
  render(<TtsCard />)
  expect(screen.getByRole("status")).toHaveTextContent("webCloudWarning")
})

it("saves each rate / pitch / volume drag once, on release, not per frame", async () => {
  testSettings = { ttsEnabled: true, ttsProvider: "system" }
  Object.values(setters).forEach((fn) => fn.mockClear())
  render(<TtsCard />)
  const cases = [
    { name: "rate", frames: ["1.1", "1.3", "1.5"], setter: setters.setTtsRate, final: 1.5 },
    { name: "pitch", frames: ["0.9", "0.8"], setter: setters.setTtsPitch, final: 0.8 },
    { name: "volume", frames: ["0.9", "0.6"], setter: setters.setTtsVolume, final: 0.6 },
  ]
  for (const { name, frames, setter, final } of cases) {
    const slider = screen.getByRole("slider", { name })
    for (const value of frames) fireEvent.change(slider, { target: { value } })
    // Each frame used to be a save, and on a paired phone a queued host update.
    expect(setter).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith(final)
  }
})

it("shows the dragged volume before it is saved", () => {
  testSettings = { ttsEnabled: true, ttsProvider: "system", ttsVolume: 1 }
  render(<TtsCard />)
  fireEvent.change(screen.getByRole("slider", { name: "volume" }), { target: { value: "0.4" } })
  expect(screen.getByText("40%")).toBeInTheDocument()
})
