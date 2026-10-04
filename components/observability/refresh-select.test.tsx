/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { RefreshSelect, refreshLabel } from "./refresh-select"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string) => key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

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

  it("formats cadences as localized durations, with 0 as Off", () => {
    const t = (key: string) => `t:${key}`
    const fmt = { duration: (ms: number | null | undefined) => `d:${ms}` }
    expect(refreshLabel(0, t, fmt)).toBe("t:off")
    expect(refreshLabel(5_000, t, fmt)).toBe("d:5000")
    expect(refreshLabel(60_000, t, fmt)).toBe("d:60000")
  })
})
