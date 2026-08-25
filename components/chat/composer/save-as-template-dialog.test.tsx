import { fireEvent, render, screen } from "@testing-library/react"
import { SaveAsTemplateDialog } from "./save-as-template-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function setup(overrides: Partial<Parameters<typeof SaveAsTemplateDialog>[0]> = {}) {
  const onSave = jest.fn(async () => undefined)
  const onOpenChange = jest.fn()
  render(
    <SaveAsTemplateDialog
      open
      body="review {{module}} on {{branch}}"
      onOpenChange={onOpenChange}
      onSave={onSave}
      {...overrides}
    />
  )
  return { onSave, onOpenChange }
}

const nameField = () => screen.getByLabelText("name")

describe("SaveAsTemplateDialog", () => {
  it("shows the body without offering to edit it", () => {
    // Re-presenting the message in a second, smaller box invites editing a copy
    // while the real one sits behind the dialog.
    setup()

    expect(screen.getByTestId("save-as-template-dialog")).toHaveTextContent(
      "review {{module}} on {{branch}}"
    )
    // Name + description are the only fields.
    expect(screen.getAllByRole("textbox")).toHaveLength(2)
  })

  it("refuses to save without a name", () => {
    const { onSave } = setup()

    fireEvent.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves the trimmed name and description", async () => {
    const { onSave, onOpenChange } = setup()

    fireEvent.change(nameField(), { target: { value: "  Review a PR  " } })
    fireEvent.change(screen.getByLabelText("templateDescription"), {
      target: { value: " looks at one module " },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith({
      name: "Review a PR",
      description: "looks at one module",
    })
    await screen.findByTestId("save-as-template-dialog")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("omits an empty description rather than storing a blank one", async () => {
    const { onSave } = setup()

    fireEvent.change(nameField(), { target: { value: "Review" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))

    expect(onSave).toHaveBeenCalledWith({ name: "Review" })
  })

  it("saves on Enter from the name field", () => {
    const { onSave } = setup()

    fireEvent.change(nameField(), { target: { value: "Review" } })
    fireEvent.keyDown(nameField(), { key: "Enter" })

    expect(onSave).toHaveBeenCalled()
  })

  it("says which parameters the template will ask for", () => {
    setup()

    expect(screen.getByTestId("save-as-template-dialog")).toHaveTextContent("descriptionWithParams")
  })

  it("uses the plain description for a body with no parameters", () => {
    setup({ body: "just prose" })

    const dialog = screen.getByTestId("save-as-template-dialog")
    expect(dialog).toHaveTextContent("description")
    expect(dialog).not.toHaveTextContent("descriptionWithParams")
  })
})
