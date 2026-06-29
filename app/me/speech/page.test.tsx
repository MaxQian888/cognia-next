/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: { ttsEnabled: false, ttsProvider: "system" },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) settingsRef.current = { ...settingsRef.current, ...patch }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

// Render the Radix Select as a native <select> so `onValueChange` is testable;
// aria-label rides on SelectTrigger, options come from SelectItem.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], meta: { label?: string; testid?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["aria-label"]) meta.label = child.props["aria-label"] as string
        if (child.props["data-testid"]) meta.testid = child.props["data-testid"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, meta)
      }
    )
  }
  const Select = ({ value, onValueChange, disabled, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const meta: { label?: string; testid?: string } = {}
    collect(children, items as unknown[], meta)
    return React.createElement(
      "select",
      {
        "aria-label": meta.label,
        "data-testid": meta.testid,
        value,
        disabled,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.children
        )
      )
    )
  }
  const SelectTrigger = () => null
  const SelectValue = () => null
  const SelectContent = ({ children }: { children: unknown }) => children
  const SelectItem = (props: unknown) => props
  ;(SelectItem as { __isItem?: boolean }).__isItem = true
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

// Render the Slider as a native range input so `onValueChange` fires on change.
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({
      value,
      onValueChange,
      disabled,
      min,
      max,
      step,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement("input", {
        type: "range",
        role: "slider",
        "aria-label": rest["aria-label"],
        "data-testid": rest["data-testid"],
        value: Array.isArray(value) ? (value as number[])[0] : value,
        min,
        max,
        step,
        disabled,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: number[]) => void)([Number(e.target.value)]),
      }),
  }
})

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = { ttsEnabled: false, ttsProvider: "system" }
})

describe("MobileSpeechPage", () => {
  it("renders the TTS + STT controls inside the sub-page shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-speech-page")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-sub-page-back")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-enabled")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-provider")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-rate")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-pitch")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-volume")).toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-autoplay")).toBeInTheDocument()
    expect(screen.getByTestId("speech-stt-language")).toBeInTheDocument()
  })

  it("links the back button to /me", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-sub-page-back").closest("a")).toHaveAttribute("href", "/me")
  })

  it("disables provider + dependent controls until TTS is enabled", () => {
    render(<Page />)
    expect(screen.getByTestId("speech-tts-provider")).toBeDisabled()
    expect(screen.getByTestId("speech-tts-autoplay")).toBeDisabled()
    expect(screen.getByTestId("speech-tts-rate")).toBeDisabled()
  })

  it("toggling TTS persists and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("speech-tts-enabled"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ ttsEnabled: true })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("changing the provider persists the selection", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "system" }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-provider"), { target: { value: "openai" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ ttsProvider: "openai" })
  })

  it("moving the rate / pitch / volume sliders persists each value", async () => {
    settingsRef.current = { ttsEnabled: true }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-rate"), { target: { value: "1.5" } })
    fireEvent.change(screen.getByTestId("speech-tts-pitch"), { target: { value: "0.8" } })
    fireEvent.change(screen.getByTestId("speech-tts-volume"), { target: { value: "0.5" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ ttsRate: 1.5 })
    expect(saveMock).toHaveBeenCalledWith({ ttsPitch: 0.8 })
    expect(saveMock).toHaveBeenCalledWith({ ttsVolume: 0.5 })
  })

  it("toggling auto-play persists the flag", async () => {
    settingsRef.current = { ttsEnabled: true }
    render(<Page />)
    fireEvent.click(screen.getByTestId("speech-tts-autoplay"))
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ ttsAutoPlay: true })
  })

  it("falls back to disabled defaults when settings are absent", () => {
    settingsRef.current = undefined
    render(<Page />)
    expect(screen.getByTestId("speech-tts-enabled")).not.toBeChecked()
    expect(screen.getByTestId("speech-tts-provider")).toBeDisabled()
    expect(screen.getByTestId("speech-stt-language")).toHaveValue("auto")
  })

  it("renders the per-provider voice picker", () => {
    render(<Page />)
    expect(screen.getByTestId("speech-tts-voice")).toBeInTheDocument()
  })

  it("changing the voice persists the active provider's voice key", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "openai" }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-voice"), { target: { value: "nova" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ openaiVoice: "nova" })
  })

  it("maps the voice key to the selected provider (gemini)", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "gemini" }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-voice"), { target: { value: "Puck" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ geminiVoice: "Puck" })
  })

  it("disables the voice picker until TTS is enabled", () => {
    render(<Page />)
    expect(screen.getByTestId("speech-tts-voice")).toBeDisabled()
  })

  it("selecting an STT language persists it; 'auto' clears the override", async () => {
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-stt-language"), { target: { value: "zh-CN" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ sttLanguage: "zh-CN" })
    fireEvent.change(screen.getByTestId("speech-stt-language"), { target: { value: "auto" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ sttLanguage: undefined })
  })
})
