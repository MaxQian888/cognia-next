import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BestOfNChip, BestOfNSelect } from "./best-of-n-chip"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count: number }) =>
    values ? `${key} ${values.count}` : key,
}))
it("offers themed options for 2, 3 and 4 attempts and an off choice", async () => {
  const user = userEvent.setup()
  const onChange = jest.fn()
  const view = render(<BestOfNSelect value={null} onChange={onChange} />)
  expect(screen.getByRole("combobox").tagName).toBe("BUTTON")
  await user.click(screen.getByRole("combobox"))
  expect(screen.getAllByRole("option")).toHaveLength(4)
  expect(screen.getByRole("listbox")).toHaveClass("bg-popover", "text-popover-foreground")
  await user.click(screen.getByRole("option", { name: "attempts 3" }))
  expect(onChange).toHaveBeenCalledWith(3)
  view.rerender(<BestOfNSelect value={3} onChange={onChange} />)
  await user.click(screen.getByRole("combobox"))
  await user.click(screen.getByRole("option", { name: "off" }))
  expect(onChange).toHaveBeenCalledWith(null)
})
it("disables the selector when sending is unavailable", () => {
  render(<BestOfNSelect value={2} onChange={jest.fn()} disabled />)
  expect(screen.getByRole("combobox")).toBeDisabled()
})

it("renders no toolbar chip while best-of-N is off", () => {
  const { container } = render(<BestOfNChip value={null} onChange={jest.fn()} />)
  expect(container).toBeEmptyDOMElement()
})

it.each([false, true])("keeps the active choice removable (compact=%s)", (compact) => {
  const onChange = jest.fn()
  render(<BestOfNChip value={3} onChange={onChange} compact={compact} />)
  expect(screen.getByText("attempts 3")).toBeInTheDocument()
  if (compact) expect(screen.getByText("compactAttempts 3")).toBeInTheDocument()
  expect(screen.getByText(/nextSend/)).toBeInTheDocument()
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "clear" }))
  expect(onChange).toHaveBeenCalledWith(null)
})

it("cannot clear a choice while sending is unavailable", () => {
  render(<BestOfNChip value={2} onChange={jest.fn()} disabled />)
  expect(screen.getByRole("button", { name: "clear" })).toBeDisabled()
})
