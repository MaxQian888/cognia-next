import { fireEvent, render, screen } from "@testing-library/react"
import { BestOfNChip } from "./best-of-n-chip"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count: number }) =>
    values ? `${key} ${values.count}` : key,
}))
it("offers only 2, 3 and 4 attempts and a removable next-send choice", () => {
  const onChange = jest.fn()
  const view = render(<BestOfNChip value={null} onChange={onChange} />)
  expect(screen.getAllByRole("option")).toHaveLength(4)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "3" } })
  expect(onChange).toHaveBeenCalledWith(3)
  view.rerender(<BestOfNChip value={3} onChange={onChange} />)
  expect(screen.getByText("nextSend")).toBeInTheDocument()
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "off" } })
  expect(onChange).toHaveBeenCalledWith(null)
})
it("disables the selector when sending is unavailable", () => {
  render(<BestOfNChip value={2} onChange={jest.fn()} disabled />)
  expect(screen.getByRole("combobox")).toBeDisabled()
})
