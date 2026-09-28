/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { FilesEmpty } from "./files-empty"

it("explains each empty tab", () => {
  const { rerender } = render(<FilesEmpty tab="favorites" filtered={false} onClear={jest.fn()} />)
  expect(screen.getByText("No favorites")).toBeInTheDocument()
  rerender(<FilesEmpty tab="images" filtered={false} onClear={jest.fn()} />)
  expect(screen.getByText("No images")).toBeInTheDocument()
  expect(screen.queryByRole("button")).toBeNull()
})

it("offers to clear a search that hid everything", () => {
  const onClear = jest.fn()
  render(<FilesEmpty tab="all" filtered onClear={onClear} />)
  expect(screen.getByText("No matches")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }))
  expect(onClear).toHaveBeenCalled()
})
