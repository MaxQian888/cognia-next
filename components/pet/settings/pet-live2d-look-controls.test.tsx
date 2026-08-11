import { render, screen, fireEvent } from "@testing-library/react"

const useActiveLive2dModel = jest.fn()
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
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
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: undefined })
  configProps.mockClear()
})

describe("PetLive2dLookControls", () => {
  it("prompts to import a model when none is active", () => {
    render(<PetLive2dLookControls pet={petSettings()} />)
    expect(screen.getByText(/no live2d model yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pet-live2d-active-name")).toBeNull()
    expect(screen.queryByTestId("pet-renderer-stub")).toBeNull()
  })

  it("shows the active model and opens its config dialog", () => {
    useActiveLive2dModel.mockReturnValue({
      modelId: "m1",
      row: { id: "m1", name: "Mochi" },
      coreReady: true,
    })
    render(<PetLive2dLookControls pet={petSettings()} />)
    expect(screen.getByTestId("pet-live2d-active-name")).toHaveTextContent("Mochi")
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
  })
})
