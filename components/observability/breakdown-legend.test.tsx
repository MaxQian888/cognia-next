/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BreakdownLegend, formatBreakdownMetric } from "./breakdown-legend"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`) plus an Intl-backed formatter — what
  // next-intl's `useFormatter` does, in "en"/UTC (next-intl is ESM-only and
  // cannot be `requireActual`-ed here).
  const translator = () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
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

const items = [
  { key: "execute_tool", label: "Tool call", value: "12", color: "#111" },
  { key: "chat", value: "3", color: "#222" },
]

describe("BreakdownLegend", () => {
  it("renders a visible, labelled list with the raw key as each label's title", () => {
    render(
      <BreakdownLegend items={items} selected={new Set()} label="By operation" testIdPrefix="lg" />
    )
    expect(screen.getByRole("list", { name: "By operation" })).toBeInTheDocument()
    expect(screen.getAllByTestId("lg")).toHaveLength(2)
    expect(screen.getByText("Tool call")).toHaveAttribute("title", "execute_tool")
    // Static rows when nothing is interactive.
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("toggles a value with aria-pressed reflecting the selection", () => {
    const onSelectValue = jest.fn()
    render(
      <BreakdownLegend
        items={items}
        selected={new Set(["chat"])}
        onSelectValue={onSelectValue}
        label="x"
        testIdPrefix="lg"
      />
    )
    expect(screen.getByTestId("lg-chat")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("lg-execute_tool")).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(screen.getByTestId("lg-execute_tool"))
    expect(onSelectValue).toHaveBeenCalledWith("execute_tool")
  })

  it("offers a separately-focusable 'Show traces' drill per row", () => {
    const onSelectValue = jest.fn()
    const onShowTraces = jest.fn()
    render(
      <BreakdownLegend
        items={items}
        selected={new Set()}
        onSelectValue={onSelectValue}
        onShowTraces={onShowTraces}
        label="x"
        testIdPrefix="lg"
      />
    )
    const drill = screen.getByTestId("lg-show-chat")
    expect(drill).toHaveAccessibleName('drill.showTraces:{"value":"chat"}')
    expect(screen.getByTestId("lg-chat").contains(drill)).toBe(false)
    fireEvent.click(drill)
    expect(onShowTraces).toHaveBeenCalledWith("chat")
    expect(onSelectValue).not.toHaveBeenCalled()
  })
})

describe("formatBreakdownMetric", () => {
  const fmt = {
    usd: (v: number | null | undefined) => `USD${v}`,
    integer: (v: number | null | undefined) => `N${v}`,
  }

  it("prints money for cost and a count otherwise", () => {
    expect(formatBreakdownMetric(2, "cost", fmt)).toBe("USD2")
    expect(formatBreakdownMetric(2, "spans", fmt)).toBe("N2")
    expect(formatBreakdownMetric(2, "errors", fmt)).toBe("N2")
  })
})
