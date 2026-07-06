import { render, screen, fireEvent } from "@testing-library/react"
import { PetNameEditor } from "./pet-name-editor"

describe("PetNameEditor", () => {
  it("shows the name and opens an input on the rename affordance", () => {
    render(<PetNameEditor name="Boba" onRename={jest.fn()} />)
    expect(screen.getByText("Boba")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-name-editor")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    expect(screen.getByTestId("pet-name-editor")).toBeInTheDocument()
  })

  it("commits a changed name on Enter and closes the editor", () => {
    const onRename = jest.fn()
    render(<PetNameEditor name="Boba" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    const input = screen.getByLabelText(/pet name|pet\.rename\.label/i)
    fireEvent.change(input, { target: { value: "  Mochi  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Mochi")
    expect(screen.queryByTestId("pet-name-editor")).not.toBeInTheDocument()
  })

  it("does not call onRename when the name is unchanged or blank", () => {
    const onRename = jest.fn()
    render(<PetNameEditor name="Boba" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    // the input renders (implicit existence assertion)
    screen.getByLabelText(/pet name|pet\.rename\.label/i)
    // unchanged
    fireEvent.click(screen.getByLabelText(/save name|pet\.rename\.save/i))
    expect(onRename).not.toHaveBeenCalled()
    // blank → save button disabled
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    fireEvent.change(screen.getByLabelText(/pet name|pet\.rename\.label/i), {
      target: { value: "   " },
    })
    expect(screen.getByLabelText(/save name|pet\.rename\.save/i)).toBeDisabled()
  })

  it("cancels with Escape and the cancel button without saving", () => {
    const onRename = jest.fn()
    render(<PetNameEditor name="Boba" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    fireEvent.keyDown(screen.getByLabelText(/pet name|pet\.rename\.label/i), { key: "Escape" })
    expect(screen.queryByTestId("pet-name-editor")).not.toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    fireEvent.click(screen.getByLabelText(/cancel|pet\.rename\.cancel/i))
    expect(screen.queryByTestId("pet-name-editor")).not.toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
  })
})
