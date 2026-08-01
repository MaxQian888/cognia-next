/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: jest.fn(() => ({ reduce: false, durationScale: 1 })),
}))

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { CursorEffectCard } from "./cursor-effect-card"
import { CURSOR_EFFECT_KINDS, DEFAULT_CURSOR_EFFECT } from "@/types/appearance"

const flowMotionMock = useFlowMotion as jest.Mock

function renderCard(overrides: Partial<typeof DEFAULT_CURSOR_EFFECT> = {}) {
  const onChange = jest.fn()
  render(
    <CursorEffectCard effect={{ ...DEFAULT_CURSOR_EFFECT, ...overrides }} onChange={onChange} />
  )
  return { onChange }
}

beforeEach(() => flowMotionMock.mockReturnValue({ reduce: false, durationScale: 1 }))

describe("CursorEffectCard", () => {
  it("offers every effect kind, including `none`", () => {
    renderCard()
    for (const kind of CURSOR_EFFECT_KINDS) {
      expect(screen.getByText(`kinds.${kind}`)).toBeInTheDocument()
    }
  })

  it("reports the chosen kind", () => {
    const { onChange } = renderCard()
    fireEvent.click(screen.getByText("kinds.petals"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "petals" }))
  })

  it("hides the tuning controls until an effect is selected", () => {
    renderCard({ kind: "none" })
    expect(screen.queryByText("intensityLabel")).toBeNull()
    expect(screen.queryByText("clickBurstLabel")).toBeNull()
  })

  it("shows the tuning controls once an effect is on", () => {
    renderCard({ kind: "sparkle" })
    expect(screen.getByText("intensityLabel")).toBeInTheDocument()
    expect(screen.getByText("scaleLabel")).toBeInTheDocument()
    expect(screen.getByText("clickBurstLabel")).toBeInTheDocument()
    expect(screen.getByText("touchNotice")).toBeInTheDocument()
  })

  it("patches only the changed field, preserving the rest of the effect", () => {
    const { onChange } = renderCard({ kind: "sparkle", intensity: 0.5, scale: 1.4 })
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CURSOR_EFFECT,
      kind: "sparkle",
      intensity: 0.5,
      scale: 1.4,
      clickBurst: false,
    })
  })

  it("writes the intensity and particle-size sliders", () => {
    const { onChange } = renderCard({ kind: "sparkle", intensity: 0.5, scale: 1 })
    const [intensity, scale] = screen.getAllByRole("slider")
    fireEvent.keyDown(intensity, { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ intensity: 0.55 }))
    onChange.mockClear()
    fireEvent.keyDown(scale, { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.1 }))
  })

  it("writes the effect color mode", () => {
    const { onChange } = renderCard({ kind: "sparkle", colorMode: "accent" })
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "colorModes.rainbow" }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ colorMode: "rainbow" }))
  })

  it("reveals the color picker only in custom mode", () => {
    renderCard({ kind: "sparkle", colorMode: "accent" })
    expect(screen.queryByText("customColorLabel")).toBeNull()
  })

  it("shows the color picker and reports edits in custom mode", () => {
    const { onChange } = renderCard({ kind: "sparkle", colorMode: "custom" })
    const input = screen.getByLabelText("customColorLabel")
    fireEvent.change(input, { target: { value: "#00b894" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ customColor: "#00b894" }))
  })

  it("says so when reduced motion will keep the layer off, rather than failing silently", () => {
    flowMotionMock.mockReturnValue({ reduce: true, durationScale: 1 })
    renderCard({ kind: "sparkle" })
    expect(screen.getByTestId("cursor-effect-reduced-motion")).toBeInTheDocument()
  })

  it("does not show the reduced-motion notice when motion is allowed", () => {
    renderCard({ kind: "sparkle" })
    expect(screen.queryByTestId("cursor-effect-reduced-motion")).toBeNull()
  })
})
