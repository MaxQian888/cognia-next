import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { DEFAULT_LIVE2D_TRANSFORM } from "@/types/pet"
import { PetModelTransformEditor } from "./pet-model-transform-editor"

describe("PetModelTransformEditor", () => {
  it("renders a slider + number input per field", () => {
    render(<PetModelTransformEditor value={DEFAULT_LIVE2D_TRANSFORM} onChange={jest.fn()} />)
    expect(screen.getAllByRole("slider")).toHaveLength(3)
    expect(document.getElementById("pet-transform-scale")).not.toBeNull()
    expect(document.getElementById("pet-transform-offsetX")).not.toBeNull()
    expect(document.getElementById("pet-transform-offsetY")).not.toBeNull()
  })

  it("number input writes through normalization (clamped)", () => {
    const onChange = jest.fn()
    render(<PetModelTransformEditor value={DEFAULT_LIVE2D_TRANSFORM} onChange={onChange} />)
    fireEvent.change(document.getElementById("pet-transform-scale") as HTMLInputElement, {
      target: { value: "9" },
    })
    expect(onChange).toHaveBeenCalledWith({ scale: 2, offsetX: 0, offsetY: 0 })
  })

  it("in-range values pass through untouched", () => {
    const onChange = jest.fn()
    render(<PetModelTransformEditor value={DEFAULT_LIVE2D_TRANSFORM} onChange={onChange} />)
    fireEvent.change(document.getElementById("pet-transform-offsetX") as HTMLInputElement, {
      target: { value: "0.25" },
    })
    expect(onChange).toHaveBeenCalledWith({ scale: 1, offsetX: 0.25, offsetY: 0 })
  })

  it("ignores non-numeric input", () => {
    const onChange = jest.fn()
    render(<PetModelTransformEditor value={DEFAULT_LIVE2D_TRANSFORM} onChange={onChange} />)
    fireEvent.change(document.getElementById("pet-transform-scale") as HTMLInputElement, {
      target: { value: "abc" },
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("slider keyboard interaction patches the value", () => {
    const onChange = jest.fn()
    render(<PetModelTransformEditor value={DEFAULT_LIVE2D_TRANSFORM} onChange={onChange} />)
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scale: expect.any(Number) }))
  })

  it("reset restores the neutral transform", () => {
    const onChange = jest.fn()
    render(
      <PetModelTransformEditor
        value={{ scale: 1.5, offsetX: 0.2, offsetY: -0.1 }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "resetTransform" }))
    expect(onChange).toHaveBeenCalledWith(DEFAULT_LIVE2D_TRANSFORM)
  })
})
