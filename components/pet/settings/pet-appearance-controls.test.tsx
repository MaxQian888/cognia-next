import { render, screen, fireEvent } from "@testing-library/react"

let coreAvailable: boolean | undefined = true
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useCubismCoreAvailable: () => coreAvailable,
}))
jest.mock("@/components/settings/pet/pet-model-manager", () => ({
  PetModelManager: () => <div data-testid="pet-model-manager" />,
}))

import { PetAppearanceControls } from "./pet-appearance-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

beforeEach(() => {
  coreAvailable = true
})

describe("PetAppearanceControls", () => {
  it("patches anchor, motion, skin, and size", () => {
    const patch = jest.fn()
    render(<PetAppearanceControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.change(document.getElementById("pet-anchor") as HTMLSelectElement, {
      target: { value: "top-left" },
    })
    expect(patch).toHaveBeenCalledWith({ anchor: "top-left" })
    fireEvent.change(document.getElementById("pet-motion") as HTMLSelectElement, {
      target: { value: "reduced" },
    })
    expect(patch).toHaveBeenCalledWith({ motion: "reduced" })
    fireEvent.change(document.getElementById("pet-skin") as HTMLSelectElement, {
      target: { value: "live2d" },
    })
    expect(patch).toHaveBeenCalledWith({ skinId: "live2d" })
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    expect(patch).toHaveBeenCalledWith({ size: expect.any(Number) })
  })

  it("warns when the live2d skin is selected but the core is missing", () => {
    coreAvailable = false
    render(
      <PetAppearanceControls
        pet={{ ...DEFAULT_PET_SETTINGS, skinId: "live2d" }}
        patch={jest.fn()}
      />
    )
    expect(screen.getByText(/runtime isn't ready/i)).toBeInTheDocument()
  })

  it("mounts the model manager only for the live2d skin", () => {
    const { rerender } = render(
      <PetAppearanceControls pet={DEFAULT_PET_SETTINGS} patch={jest.fn()} />
    )
    expect(screen.queryByTestId("pet-model-manager")).toBeNull()
    rerender(
      <PetAppearanceControls
        pet={{ ...DEFAULT_PET_SETTINGS, skinId: "live2d" }}
        patch={jest.fn()}
      />
    )
    expect(screen.getByTestId("pet-model-manager")).toBeInTheDocument()
  })
})
