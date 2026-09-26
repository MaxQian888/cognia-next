/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

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

// Render the Slider as a native range input: `change` is one drag frame
// (`onValueChange`), `pointerUp` the release (`onValueCommit`) with the thumb's
// current value.
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({
      value,
      onValueChange,
      onValueCommit,
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
        onPointerUp: (e: { currentTarget: { value: string } }) =>
          (onValueCommit as (v: number[]) => void)([Number(e.currentTarget.value)]),
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

  it("hides rate/pitch for a cloud provider but keeps volume (W13)", () => {
    // Rate + pitch only drive the system voice; they were dead controls for
    // cloud providers, which use their own speed field.
    settingsRef.current = { ttsEnabled: true, ttsProvider: "openai" }
    render(<Page />)
    expect(screen.queryByTestId("speech-tts-rate")).not.toBeInTheDocument()
    expect(screen.queryByTestId("speech-tts-pitch")).not.toBeInTheDocument()
    expect(screen.getByTestId("speech-tts-volume")).toBeInTheDocument()
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
    // Host mirroring moved out of `useSettingsPatch` and into the persistence
    // funnel (`lib/settings/mirror-to-host.ts`) so it also covers the mobile
    // routes that embed a desktop settings section. Enqueuing here as well
    // would send every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("changing the provider persists the selection", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "system" }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-provider"), { target: { value: "openai" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ ttsProvider: "openai" })
  })

  it("persists each rate / pitch / volume drag once, on release, not per frame", async () => {
    settingsRef.current = { ttsEnabled: true }
    render(<Page />)
    const drag = async (testid: string, frames: string[]) => {
      const slider = screen.getByTestId(testid)
      for (const value of frames) fireEvent.change(slider, { target: { value } })
      // Each frame used to be its own save — and its own queued desktop update.
      expect(saveMock).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.pointerUp(slider)
      })
    }

    await drag("speech-tts-rate", ["1.1", "1.3", "1.5"])
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenLastCalledWith({ ttsRate: 1.5 })
    saveMock.mockClear()

    await drag("speech-tts-pitch", ["0.9", "0.8"])
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenLastCalledWith({ ttsPitch: 0.8 })
    saveMock.mockClear()

    await drag("speech-tts-volume", ["0.9", "0.7", "0.5"])
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenLastCalledWith({ ttsVolume: 0.5 })
  })

  it("shows the dragged value in the read-out before it is saved", () => {
    settingsRef.current = { ttsEnabled: true, ttsVolume: 1 }
    render(<Page />)
    fireEvent.change(screen.getByTestId("speech-tts-volume"), { target: { value: "0.4" } })
    expect(screen.getByText("Volume · 40%")).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("commits a typed voice id once, on blur, to the provider's key", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "mistral" }
    render(<Page />)
    const input = screen.getByTestId("speech-tts-voice-id")
    fireEvent.change(input, { target: { value: "v" } })
    fireEvent.change(input, { target: { value: "voice-7 " } })
    expect(saveMock).not.toHaveBeenCalled()
    expect(input).toHaveValue("voice-7 ")

    await act(async () => {
      fireEvent.blur(input)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ mistralVoiceId: "voice-7" })
  })

  it("commits a typed voice id on Enter and skips an unchanged one", async () => {
    settingsRef.current = { ttsEnabled: true, ttsProvider: "mistral", mistralVoiceId: "abc" }
    render(<Page />)
    const input = screen.getByTestId("speech-tts-voice-id")
    fireEvent.change(input, { target: { value: " abc " } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(saveMock).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "xyz" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(saveMock).toHaveBeenCalledWith({ mistralVoiceId: "xyz" })
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
