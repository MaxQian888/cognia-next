import { render, screen, fireEvent } from "@testing-library/react"

const usePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: () => usePet() }))

const useActiveLive2dModel = jest.fn()
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Capture the preview renderer's props (skin resolution) and the dialog mount.
const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (p: unknown) => {
    rendererProps(p)
    return <div data-testid="pet-renderer-stub" />
  },
}))
const configProps = jest.fn()
jest.mock("@/components/settings/pet/pet-model-config-dialog", () => ({
  PetModelConfigDialog: (p: { onOpenChange: (open: boolean) => void }) => {
    configProps(p)
    // Clicking the stub closes it, exercising the caller's onOpenChange path.
    return <button data-testid="pet-model-config-dialog" onClick={() => p.onOpenChange(false)} />
  },
}))

import { PetLive2dLookControls } from "./pet-live2d-look-controls"
import type { PetSettings } from "@/types/pet"

const petSettings = (over: Partial<PetSettings> = {}): PetSettings =>
  ({
    enabled: true,
    anchor: "bottom-right",
    motion: "auto",
    mutedBubbles: false,
    size: 96,
    skinId: "live2d",
    ...over,
  }) as PetSettings

beforeEach(() => {
  usePet.mockReturnValue({
    profile: { stage: "adult", soul: { name: "P" } },
    view: { effectiveBones: { species: "cat" } },
  })
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: undefined })
  rendererProps.mockClear()
  configProps.mockClear()
})

describe("PetLive2dLookControls", () => {
  it("renders nothing until the pet view is ready", () => {
    usePet.mockReturnValue({ profile: undefined, view: undefined })
    const { container } = render(<PetLive2dLookControls pet={petSettings()} />)
    expect(container.firstChild).toBeNull()
  })

  it("prompts to import a model when none is active", () => {
    render(<PetLive2dLookControls pet={petSettings()} />)
    expect(screen.getByText(/no live2d model yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pet-live2d-active-name")).toBeNull()
    // The preview falls back to the built-in mascot.
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })

  it("shows the active model and opens its config dialog", () => {
    useActiveLive2dModel.mockReturnValue({
      modelId: "m1",
      row: { id: "m1", name: "Mochi" },
      coreReady: true,
    })
    render(<PetLive2dLookControls pet={petSettings()} />)
    expect(screen.getByTestId("pet-live2d-active-name")).toHaveTextContent("Mochi")
    // Effective skin is Live2D → the preview renders the model.
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "live2d" }))
    expect(screen.queryByTestId("pet-model-config-dialog")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /adjust size & motion/i }))
    expect(screen.getByTestId("pet-model-config-dialog")).toBeInTheDocument()
    expect(configProps).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: "m1", name: "Mochi" }, open: true })
    )
    // Closing it from within unmounts the dialog (onOpenChange → setConfigOpen).
    fireEvent.click(screen.getByTestId("pet-model-config-dialog"))
    expect(screen.queryByTestId("pet-model-config-dialog")).toBeNull()
  })

  it("explains the SVG fallback when the runtime is missing", () => {
    useActiveLive2dModel.mockReturnValue({
      modelId: "m1",
      row: { id: "m1", name: "Mochi" },
      coreReady: false,
    })
    render(<PetLive2dLookControls pet={petSettings()} />)
    expect(screen.getByRole("status")).toHaveTextContent(/runtime isn't ready/i)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })
})
