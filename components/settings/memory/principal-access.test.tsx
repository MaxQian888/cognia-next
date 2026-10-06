/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryPrincipalAccess } from "./principal-access"

it("saves explicit project access without global scope and retains failed drafts", async () => {
  const save = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  render(<MemoryPrincipalAccess save={save} />)
  fireEvent.change(screen.getByLabelText("Caller identity"), { target: { value: "plugin:p" } })
  fireEvent.click(screen.getByLabelText("Global"))
  fireEvent.change(screen.getByLabelText("Project IDs"), { target: { value: "a, a, b" } })
  fireEvent.click(screen.getByRole("button", { name: "Save restriction" }))
  await screen.findByRole("alert")
  expect(screen.getByLabelText("Caller identity")).toHaveValue("plugin:p")
  expect(save).toHaveBeenCalledWith({
    "plugin:p": { scopes: ["workspace", "character", "agent"], projects: ["a", "b"] },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save restriction" }))
  await waitFor(() => expect(screen.getByLabelText("Caller identity")).toHaveValue(""))
})

it("revokes all access without silently restoring account defaults", async () => {
  const save = jest.fn().mockResolvedValue(undefined)
  render(<MemoryPrincipalAccess grants={{ "plugin:p": { projects: ["a"] } }} save={save} />)
  fireEvent.click(screen.getByRole("button", { name: "Deny all" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ "plugin:p": { scopes: [] } }))
})
