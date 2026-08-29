import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import type { SiteSecretEdit } from "@/types/sites"
import { SiteSecretEditor } from "./site-secret-editor"

function renderEditor(edits: SiteSecretEdit[], storedKeys = edits.map((edit) => edit.key)) {
  const onChange = jest.fn()
  render(<SiteSecretEditor storedKeys={storedKeys} edits={edits} onChange={onChange} />)
  return { onChange }
}

it("never renders a stored value — there is none to render", () => {
  // The value lives in the host keyring and is unreadable by design. That is
  // the whole reason a plain key/value grid could not express this.
  renderEditor([{ key: "API_TOKEN", action: "keep" }])
  expect(screen.getByTestId("site-secret-API_TOKEN")).toHaveTextContent(
    "environment.secretAction.keptHint"
  )
  // The only text field is the "add a key" box; a kept secret contributes none.
  expect(screen.getAllByRole("textbox")).toHaveLength(1)
  expect(screen.getByRole("textbox")).toHaveAccessibleName("environment.secretAction.newKey")
})

it("switches a kept secret to a replacement value", async () => {
  const user = userEvent.setup()
  const { onChange } = renderEditor([{ key: "API_TOKEN", action: "keep" }])
  await user.click(screen.getByTestId("site-secret-replace-API_TOKEN"))
  expect(onChange).toHaveBeenCalledWith([{ key: "API_TOKEN", action: "set", value: "" }])
})

it("marks a stored secret for removal instead of dropping the row", async () => {
  // Dropping the row would make "remove" and "forgot to mention it" the same
  // gesture, which is the failure this model exists to prevent.
  const user = userEvent.setup()
  const { onChange } = renderEditor([{ key: "API_TOKEN", action: "keep" }])
  await user.click(screen.getByTestId("site-secret-remove-API_TOKEN"))
  expect(onChange).toHaveBeenCalledWith([{ key: "API_TOKEN", action: "remove" }])
})

it("drops an unsaved new secret outright rather than marking it removed", async () => {
  const user = userEvent.setup()
  const { onChange } = renderEditor([{ key: "NEW", action: "set", value: "v" }], [])
  await user.click(screen.getByTestId("site-secret-remove-NEW"))
  expect(onChange).toHaveBeenCalledWith([])
})

it("offers keep as the way back from a removal", async () => {
  const user = userEvent.setup()
  const { onChange } = renderEditor([{ key: "API_TOKEN", action: "remove" }])
  await user.click(screen.getByTestId("site-secret-keep-API_TOKEN"))
  expect(onChange).toHaveBeenCalledWith([{ key: "API_TOKEN", action: "keep" }])
})

it("does not offer keep for a key no revision holds", () => {
  renderEditor([{ key: "NEW", action: "set", value: "" }], [])
  expect(screen.queryByTestId("site-secret-keep-NEW")).not.toBeInTheDocument()
})

it("adds a new key and refuses a duplicate", async () => {
  const user = userEvent.setup()
  const { onChange } = renderEditor([{ key: "API_TOKEN", action: "keep" }])
  const field = screen.getByLabelText("environment.secretAction.newKey")

  await user.type(field, "API_TOKEN")
  await user.click(screen.getByTestId("site-secret-add"))
  expect(onChange).not.toHaveBeenCalled()

  await user.clear(field)
  await user.type(field, "DB_PASSWORD")
  await user.click(screen.getByTestId("site-secret-add"))
  expect(onChange).toHaveBeenCalledWith([
    { key: "API_TOKEN", action: "keep" },
    { key: "DB_PASSWORD", action: "set", value: "" },
  ])
})

it("says so when there are no secrets at all", () => {
  renderEditor([], [])
  expect(screen.getByText("environment.noSecretRefs")).toBeInTheDocument()
})
