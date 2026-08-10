/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { RefreshSelect } from "./refresh-select"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Render shadcn Select as a native <select> so jsdom can drive it.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select
      data-testid="refresh-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  // Trigger holds an icon (svg) + value; rendering it inside the native
  // <select> mock would trip React's DOM-nesting validator, so drop it.
  SelectTrigger: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

describe("RefreshSelect", () => {
  it("renders an option per cadence with friendly labels", () => {
    render(<RefreshSelect value={10_000} onChange={jest.fn()} />)
    const select = screen.getByTestId("refresh-select") as HTMLSelectElement
    expect(select.value).toBe("10000")
    expect(screen.getByRole("option", { name: "off" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "5s" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "1m" })).toBeInTheDocument()
  })

  it("fires onChange with the numeric cadence", () => {
    const onChange = jest.fn()
    render(<RefreshSelect value={0} onChange={onChange} />)
    fireEvent.change(screen.getByTestId("refresh-select"), { target: { value: "30000" } })
    expect(onChange).toHaveBeenCalledWith(30_000)
  })
})
