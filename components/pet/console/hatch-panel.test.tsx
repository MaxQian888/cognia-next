import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: { stage: string; lowPower?: boolean }) => (
    <div data-testid="egg" data-stage={props.stage} data-low-power={props.lowPower || undefined} />
  ),
}))

import { toast } from "sonner"
import type { PetActionOutcome } from "@/lib/pet/console/outcome-messages"
import type { PetBones } from "@/types/pet"
import { HatchPanel } from "./hatch-panel"

const bones = {} as PetBones
const errorToast = toast.error as jest.Mock

beforeEach(() => errorToast.mockClear())

describe("HatchPanel", () => {
  it("draws the egg and a hatch button", () => {
    render(<HatchPanel bones={bones} onHatch={jest.fn()} lowPower />)
    expect(screen.getByTestId("egg")).toHaveAttribute("data-stage", "egg")
    expect(screen.getByTestId("egg")).toHaveAttribute("data-low-power", "true")
    expect(screen.getByRole("button", { name: /hatch/i })).toBeEnabled()
  })

  it("disables itself while hatching so a second click cannot start a second soul", async () => {
    let finish!: (o: PetActionOutcome) => void
    const onHatch = jest.fn(() => new Promise<PetActionOutcome>((resolve) => (finish = resolve)))
    render(<HatchPanel bones={bones} onHatch={onHatch} />)
    const button = screen.getByRole("button", { name: /hatch/i })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()
    expect(screen.getByText(/hatching/i)).toBeInTheDocument()
    fireEvent.click(button)
    expect(onHatch).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ ok: true })
    })
    expect(button).toBeEnabled()
    expect(errorToast).not.toHaveBeenCalled()
  })

  // The console's actions already told the user why; the panel only has to
  // let them try again, without a second toast.
  it("re-enables after a failed hatch without telling the user twice", async () => {
    const onHatch = jest.fn(async (): Promise<PetActionOutcome> => ({
      ok: false,
      reason: "failed",
      message: { key: "console.hatchFailed" },
    }))
    render(<HatchPanel bones={bones} onHatch={onHatch} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch/i }))
    })
    expect(errorToast).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: /hatch/i })).toBeEnabled()
  })

  it("still answers an action that throws instead of spinning forever", async () => {
    const onHatch = jest
      .fn<Promise<PetActionOutcome>, []>()
      .mockRejectedValueOnce(new Error("boom"))
    render(<HatchPanel bones={bones} onHatch={onHatch} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch/i }))
    })
    expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/hatch/i))
    expect(screen.getByRole("button", { name: /hatch/i })).toBeEnabled()
  })
})
