import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const messages = require("@/i18n/messages/en.json") as {
  chat: { imageWorkbench: Record<string, Record<string, unknown>> }
}

import { ASPECT_PRESETS } from "@/lib/images"
import type { ImageWorkbenchAiState } from "@/hooks/chat/use-image-workbench"

import { AdjustPanel, AiPanel, TransformPanel, ADJUSTMENT_SLIDERS } from "./workbench-panels"

const SIZE = { width: 800, height: 600 }

function transformProps(overrides: Record<string, unknown> = {}) {
  return {
    size: SIZE,
    cropRect: null,
    onCropRectChange: jest.fn(),
    aspectId: "free",
    onAspectChange: jest.fn(),
    onApplyCrop: jest.fn(),
    onResize: jest.fn(),
    onRotate: jest.fn(),
    onFlip: jest.fn(),
    lockAspect: true,
    onLockAspectChange: jest.fn(),
    ...overrides,
  } as never
}

describe("TransformPanel", () => {
  it("offers every aspect preset the engine defines", () => {
    render(<TransformPanel {...transformProps()} />)
    for (const preset of ASPECT_PRESETS) {
      const label = messages.chat.imageWorkbench.crop.aspect as Record<string, string>
      expect(screen.getByLabelText(label[preset.id])).toBeInTheDocument()
    }
  })

  it("seeds a crop rect when an aspect is chosen with nothing selected", async () => {
    const props = transformProps()
    render(<TransformPanel {...props} />)
    await userEvent.click(screen.getByLabelText("16:9"))
    expect(props.onAspectChange).toHaveBeenCalledWith("landscape16x9")
    const rect = props.onCropRectChange.mock.calls.at(-1)[0]
    expect(rect.width / rect.height).toBeCloseTo(16 / 9, 1)
  })

  it("cannot apply a crop until one exists", async () => {
    const props = transformProps()
    const { rerender } = render(<TransformPanel {...props} />)
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeDisabled()

    rerender(
      <TransformPanel
        {...transformProps({
          cropRect: { x: 0, y: 0, width: 100, height: 50 },
          onApplyCrop: props.onApplyCrop,
        })}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "Apply crop" }))
    expect(props.onApplyCrop).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 50 })
  })

  it("shows the crop size so the result is predictable before applying", () => {
    render(
      <TransformPanel {...transformProps({ cropRect: { x: 1, y: 2, width: 320, height: 180 } })} />
    )
    expect(screen.getByTestId("workbench-crop-size")).toHaveTextContent("320 x 180")
  })

  it("derives the other dimension while proportions are locked", async () => {
    render(<TransformPanel {...transformProps()} />)
    const width = screen.getByLabelText("Width")
    await userEvent.clear(width)
    await userEvent.type(width, "400")
    expect(width).toHaveValue(400)
    expect(screen.getByLabelText("Height")).toHaveValue(300)
  })

  it("lets the width field be cleared without snapping to a number", async () => {
    // Parsing every keystroke back into the field is what made clearing it
    // land on 1, so a typed 400 came out as 1400.
    render(<TransformPanel {...transformProps()} />)
    const width = screen.getByLabelText("Width")
    await userEvent.clear(width)
    expect(width).toHaveValue(null)
  })

  it("commits the typed size only when Apply is pressed", async () => {
    const props = transformProps()
    render(<TransformPanel {...props} />)
    const width = screen.getByLabelText("Width")
    await userEvent.clear(width)
    await userEvent.type(width, "400")
    expect(props.onResize).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Apply size" }))
    expect(props.onResize).toHaveBeenCalledWith(400, 300)
  })

  it("ignores an Apply with an unusable size", async () => {
    const props = transformProps()
    render(<TransformPanel {...props} />)
    await userEvent.clear(screen.getByLabelText("Width"))
    await userEvent.click(screen.getByRole("button", { name: "Apply size" }))
    expect(props.onResize).not.toHaveBeenCalled()
  })

  it("rotates and flips through the callbacks", async () => {
    const props = transformProps()
    render(<TransformPanel {...props} />)
    await userEvent.click(screen.getByRole("button", { name: "Rotate left" }))
    await userEvent.click(screen.getByRole("button", { name: "Rotate right" }))
    await userEvent.click(screen.getByRole("button", { name: "Flip horizontally" }))
    await userEvent.click(screen.getByRole("button", { name: "Flip vertically" }))
    expect(props.onRotate.mock.calls).toEqual([[-1], [1]])
    expect(props.onFlip.mock.calls).toEqual([["horizontal"], ["vertical"]])
  })
})

describe("AdjustPanel", () => {
  it("renders every adjustment the engine implements", () => {
    render(<AdjustPanel adjustments={{}} onChange={jest.fn()} onReset={jest.fn()} />)
    expect(screen.getAllByRole("slider")).toHaveLength(ADJUSTMENT_SLIDERS.length)
  })

  it("has a translation for every slider key", () => {
    // The labels are looked up as `adjust.<key>`, which `lint:i18n` cannot see
    // through. Without this the panel would silently render raw key paths.
    const catalogue = messages.chat.imageWorkbench.adjust as Record<string, string>
    for (const slider of ADJUSTMENT_SLIDERS) {
      expect(typeof catalogue[slider.key]).toBe("string")
      expect(screen.queryByLabelText(catalogue[slider.key])).not.toBeUndefined()
    }
  })

  it("shows the neutral value for an adjustment that is not set", () => {
    render(<AdjustPanel adjustments={{}} onChange={jest.fn()} onReset={jest.fn()} />)
    // Gamma is neutral at 1, not 0, so a naive default would render it wrong.
    expect(screen.getByText("1.00")).toBeInTheDocument()
  })

  it("resets through the callback", async () => {
    const onReset = jest.fn()
    render(<AdjustPanel adjustments={{ brightness: 20 }} onChange={jest.fn()} onReset={onReset} />)
    await userEvent.click(screen.getByRole("button", { name: "Reset adjustments" }))
    expect(onReset).toHaveBeenCalled()
  })
})

const openai = { providerId: "openai" as const, modelId: "gpt-image-1", supportsMask: true }
const xai = { providerId: "xai" as const, modelId: "grok-2-image", supportsMask: false }

function aiState(overrides: Partial<ImageWorkbenchAiState> = {}): ImageWorkbenchAiState {
  return {
    capabilities: { options: [openai], preferred: openai, unavailable: null },
    running: false,
    error: null,
    capability: openai,
    selectCapability: jest.fn(),
    run: jest.fn(),
    runRegion: jest.fn(),
    cancel: jest.fn(),
    ...overrides,
  } as ImageWorkbenchAiState
}

function aiProps(overrides: Record<string, unknown> = {}) {
  return {
    ai: aiState(),
    prompt: "",
    onPromptChange: jest.fn(),
    regionMode: false,
    onRegionModeChange: jest.fn(),
    brush: { radius: 32, hardness: 0.8, mode: "add" as const },
    onBrushChange: jest.fn(),
    hasSelection: false,
    onClearSelection: jest.fn(),
    onRun: jest.fn(),
    ...overrides,
  } as never
}

describe("AiPanel", () => {
  it("explains an empty provider list instead of rendering a dead form", () => {
    render(
      <AiPanel
        {...aiProps({
          ai: aiState({
            capabilities: {
              options: [],
              preferred: null,
              unavailable: { reason: "needs-auth" },
            },
          }),
        })}
      />
    )
    expect(screen.getByTestId("workbench-ai-unavailable")).toHaveTextContent("needs an API key")
    expect(screen.queryByTestId("workbench-ai-panel")).not.toBeInTheDocument()
  })

  it("has a message for every unavailable reason", () => {
    const catalogue = messages.chat.imageWorkbench.ai.unavailable as Record<string, string>
    for (const reason of ["no-provider", "needs-auth", "needs-config"]) {
      expect(typeof catalogue[reason]).toBe("string")
    }
  })

  it("disables region editing but keeps the panel when the provider takes no mask", () => {
    // Hiding the panel would hide whole-image prompt editing, which this
    // provider does support.
    render(
      <AiPanel
        {...aiProps({
          ai: aiState({
            capability: xai,
            capabilities: { options: [xai], preferred: xai, unavailable: null },
          }),
        })}
      />
    )
    expect(screen.getByTestId("workbench-ai-panel")).toBeInTheDocument()
    expect(screen.getByTestId("workbench-mask-unsupported")).toHaveTextContent(
      "xai cannot edit a selected region"
    )
    expect(screen.getByRole("switch", { name: /region/i })).toBeDisabled()
  })

  it("names the model that will run", () => {
    render(<AiPanel {...aiProps()} />)
    expect(screen.getByTestId("workbench-ai-model")).toHaveTextContent("gpt-image-1")
  })

  it("says a run is billed before the user starts one", () => {
    render(<AiPanel {...aiProps()} />)
    expect(screen.getByText(/billed request/i)).toBeInTheDocument()
  })

  it("refuses to generate with an empty prompt", () => {
    render(<AiPanel {...aiProps()} />)
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled()
  })

  it("refuses a region run with nothing selected", () => {
    render(<AiPanel {...aiProps({ prompt: "erase it", regionMode: true, hasSelection: false })} />)
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled()
  })

  it("runs once a prompt exists", async () => {
    const props = aiProps({ prompt: "make it blue" })
    render(<AiPanel {...props} />)
    await userEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(props.onRun).toHaveBeenCalled()
  })

  it("offers cancel only while a run is in flight", () => {
    const { rerender } = render(<AiPanel {...aiProps({ prompt: "p" })} />)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    rerender(<AiPanel {...aiProps({ prompt: "p", ai: aiState({ running: true }) })} />)
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("offers a retry only for a retryable failure", () => {
    const { rerender } = render(
      <AiPanel
        {...aiProps({
          prompt: "p",
          ai: aiState({ error: { code: "provider", message: "502", retryable: true } }),
        })}
      />
    )
    expect(screen.getByTestId("workbench-ai-error")).toHaveTextContent("502")
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()

    rerender(
      <AiPanel
        {...aiProps({
          prompt: "p",
          ai: aiState({ error: { code: "blocked", message: "redact", retryable: false } }),
        })}
      />
    )
    expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument()
  })

  it("removes the background without needing a prompt", async () => {
    const ai = aiState()
    render(<AiPanel {...aiProps({ ai })} />)
    await userEvent.click(screen.getByRole("button", { name: "Remove background" }))
    expect(ai.run).toHaveBeenCalledWith({ kind: "remove-background" })
  })

  it("shows the brush controls only in region mode", () => {
    const { rerender } = render(<AiPanel {...aiProps()} />)
    expect(screen.queryByTestId("workbench-brush-controls")).not.toBeInTheDocument()
    rerender(<AiPanel {...aiProps({ regionMode: true })} />)
    expect(screen.getByTestId("workbench-brush-controls")).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "Brush size" })).toBeInTheDocument()
  })
})
