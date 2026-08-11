import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PetSoundControls } from "./pet-sound-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

const withSound = (sound: PetSettings["sound"]): PetSettings => ({ ...DEFAULT_PET_SETTINGS, sound })

describe("PetSoundControls", () => {
  it("enables sound and shows the volume + quiet-hours controls", () => {
    const patch = jest.fn()
    const { rerender } = render(<PetSoundControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-sound-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ sound: expect.objectContaining({ enabled: true }) })

    rerender(<PetSoundControls pet={withSound({ enabled: true, volume: 0.5 })} patch={patch} />)
    expect(document.getElementById("pet-sound-quiet")).not.toBeNull()
    expect(screen.queryByTestId("pet-quiet-hours")).toBeNull()
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    expect(patch).toHaveBeenCalledWith({
      sound: expect.objectContaining({ volume: expect.any(Number) }),
    })
  })

  it("enabling quiet hours seeds a default window; editing patches start/end", async () => {
    const user = userEvent.setup()
    const patch = jest.fn()
    const { rerender } = render(
      <PetSoundControls pet={withSound({ enabled: true, volume: 0.5 })} patch={patch} />
    )
    fireEvent.click(document.getElementById("pet-sound-quiet") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({
      sound: expect.objectContaining({ quietHours: { start: 22, end: 7 } }),
    })

    rerender(
      <PetSoundControls
        pet={withSound({ enabled: true, volume: 0.5, quietHours: { start: 22, end: 7 } })}
        patch={patch}
      />
    )
    expect(screen.getByTestId("pet-quiet-hours")).toBeInTheDocument()
    await user.click(screen.getByRole("combobox", { name: /from/i }))
    await user.click(screen.getByRole("option", { name: "23:00" }))
    expect(patch).toHaveBeenCalledWith({
      sound: expect.objectContaining({ quietHours: { start: 23, end: 7 } }),
    })
    await user.click(screen.getByRole("combobox", { name: /to/i }))
    await user.click(screen.getByRole("option", { name: "08:00" }))
    expect(patch).toHaveBeenCalledWith({
      sound: expect.objectContaining({ quietHours: { start: 22, end: 8 } }),
    })
  })

  it("defaults the volume label when volume is absent", () => {
    render(<PetSoundControls pet={withSound({ enabled: true })} patch={jest.fn()} />)
    // 0.5 fallback → "50%".
    expect(screen.getByText(/50%/)).toBeInTheDocument()
  })

  it("disabling quiet hours clears the window", () => {
    const patch = jest.fn()
    render(
      <PetSoundControls
        pet={withSound({ enabled: true, volume: 0.5, quietHours: { start: 22, end: 7 } })}
        patch={patch}
      />
    )
    fireEvent.click(document.getElementById("pet-sound-quiet") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ sound: expect.objectContaining({ quietHours: null }) })
  })
})
