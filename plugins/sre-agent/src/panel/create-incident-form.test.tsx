/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { en, registerSreBundle, unregisterSreBundle } from "../i18n.test-helpers"
import { CreateIncidentForm } from "./create-incident-form"

beforeEach(() => registerSreBundle())
afterEach(() => unregisterSreBundle())

function renderForm() {
  const onSubmit = jest.fn()
  const onCancel = jest.fn()
  render(<CreateIncidentForm onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel }
}

describe("CreateIncidentForm", () => {
  it("labels both fields for assistive tech", () => {
    renderForm()
    expect(screen.getByLabelText(en("create.titleLabel"))).toBeInTheDocument()
    expect(screen.getByLabelText(en("create.environmentLabel"))).toHaveValue("prod")
    expect(screen.getByRole("form", { name: en("create.heading") })).toBeInTheDocument()
  })

  it("refuses an empty description and says why", async () => {
    const { onSubmit } = renderForm()
    await userEvent.type(screen.getByLabelText(en("create.titleLabel")), "   ")
    await userEvent.click(screen.getByRole("button", { name: en("create.submit") }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(en("create.titleRequired"))
    expect(screen.getByLabelText(en("create.titleLabel"))).toHaveAttribute("aria-invalid", "true")
  })

  it("submits the trimmed description and environment", async () => {
    const { onSubmit } = renderForm()
    await userEvent.type(screen.getByLabelText(en("create.titleLabel")), "  gateway 504s  ")
    const environment = screen.getByLabelText(en("create.environmentLabel"))
    await userEvent.clear(environment)
    await userEvent.type(environment, "staging{Enter}")
    expect(onSubmit).toHaveBeenCalledWith({ title: "gateway 504s", environment: "staging" })
  })

  it("falls back to the default environment when it is cleared", async () => {
    const { onSubmit } = renderForm()
    await userEvent.type(screen.getByLabelText(en("create.titleLabel")), "x")
    await userEvent.clear(screen.getByLabelText(en("create.environmentLabel")))
    await userEvent.click(screen.getByRole("button", { name: en("create.submit") }))
    expect(onSubmit).toHaveBeenCalledWith({ title: "x", environment: "prod" })
  })

  it("cancels without submitting, with touch-size buttons", async () => {
    const { onSubmit, onCancel } = renderForm()
    const cancel = screen.getByRole("button", { name: en("create.cancel") })
    expect(cancel.className).toMatch(/(^|\s)h-9(\s|$)/)
    await userEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
