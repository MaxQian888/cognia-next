import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { EntityPicker } from "./entity-picker"

it("keeps a missing reference visible and clearable", async () => {
  const onChange = jest.fn()
  render(
    <EntityPicker
      id="entity"
      value="missing"
      items={[{ id: "active", label: "Active" }]}
      emptyLabel="Inherit"
      missingLabel={(id) => `Missing: ${id}`}
      onChange={onChange}
    />
  )
  expect(screen.getByTestId("entity")).toHaveTextContent("Missing: missing")
  await userEvent.click(screen.getByTestId("entity"))
  await userEvent.click(screen.getByRole("option", { name: "Inherit" }))
  expect(onChange).toHaveBeenCalledWith(undefined)
})
