import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { INVENTORY_KEYS, type Inventory } from "@web/lib/evidence"

import { InventoryFigures } from "./inventory-figures"

function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    plugins: 59,
    connectors: 11,
    workflowNodeKinds: 185,
    crates: 35,
    packages: 32,
    adrs: 167,
    testFiles: 9496,
    ...overrides,
  }
}

describe("InventoryFigures", () => {
  it("shows one figure per inventory key, labelled, in display order", () => {
    const { container } = render(
      <InventoryFigures copy={en.inventory} inventory={inventory()} locale="en" />
    )
    const cells = [...container.querySelectorAll("[data-figure]")].map((cell) =>
      cell.getAttribute("data-figure")
    )
    expect(cells).toEqual([...INVENTORY_KEYS])
    for (const key of INVENTORY_KEYS) {
      expect(screen.getByText(en.inventory.figures[key])).toBeInTheDocument()
    }
    expect(screen.getByText(en.inventory.figuresNote)).toBeInTheDocument()
  })

  it("shows a dash rather than a zero when a count did not run", () => {
    const { container } = render(
      <InventoryFigures copy={en.inventory} inventory={inventory({ crates: 0 })} locale="en" />
    )
    const cell = container.querySelector('[data-figure="crates"]') as HTMLElement
    expect(within(cell).getByText("—")).toBeInTheDocument()
  })

  it.each(["en", "zh"] as const)("shows every count at its value, formatted, in %s", (locale) => {
    const data = inventory()
    const copy = locale === "en" ? en : zh
    const { container } = render(
      <InventoryFigures copy={copy.inventory} inventory={data} locale={locale} />
    )
    const formatter = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US")
    for (const key of INVENTORY_KEYS) {
      const cell = container.querySelector(`[data-figure="${key}"]`) as HTMLElement
      expect(within(cell).getByText(formatter.format(data[key]))).toBeInTheDocument()
    }
  })

  it("never ticks up to a figure: the first render already reads the final count", () => {
    const { container } = render(
      <InventoryFigures copy={en.inventory} inventory={inventory()} locale="en" />
    )
    expect(container.querySelector('[data-slot="number-ticker"]')).toBeNull()
    expect(container.querySelector('[data-figure="testFiles"]')).toHaveTextContent("9,496")
  })

  it("sits on four columns, the last figure closing the open cell", () => {
    const { container } = render(
      <InventoryFigures copy={en.inventory} inventory={inventory()} locale="en" />
    )
    const grid = container.querySelector('[data-slot="inventory"]') as HTMLElement
    expect(grid).toHaveClass("grid-cols-2", "lg:grid-cols-4", "[&>*:last-child]:col-span-2")
    expect(grid).not.toHaveClass("xl:grid-cols-7")
  })

  it("takes the cell padding a section aligns its bands on", () => {
    const { container } = render(
      <InventoryFigures
        copy={en.inventory}
        inventory={inventory()}
        locale="en"
        cellClassName="px-5 py-6"
      />
    )
    expect(container.querySelector("[data-figure]")).toHaveClass("px-5", "py-6")
  })

  it("paints its cells in the surrounding section's tone", () => {
    const { container } = render(
      <InventoryFigures copy={en.inventory} inventory={inventory()} locale="en" tone="surface" />
    )
    expect(container.querySelector("[data-figure]")).toHaveClass("bg-surface")
  })
})
