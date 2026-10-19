import type { InventoryCopy } from "@web/content/types"
import { INVENTORY_KEYS, inventoryFigure, type Inventory } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface InventoryFiguresProps {
  copy: InventoryCopy
  inventory: Inventory
  locale: Locale
  /** Cell background; must match the surrounding section's tone. */
  tone?: "paper" | "surface"
  /** Padding for each cell, so a section can align it with its other bands. */
  cellClassName?: string
  className?: string
}

/**
 * Figures counted from the checkout at build time (The Counted Figures Rule).
 *
 * Laid on four columns, the same lines as the trust section's other bands;
 * seven figures leave one open cell, which the last figure spans closed.
 * Figures render at their value rather than ticking up to it: a count read or
 * captured halfway is a wrong count. Nothing here is a KPI: a zero from the
 * counter means the count did not run and is shown as a dash, never as a
 * confident nought.
 */
export function InventoryFigures({
  copy,
  inventory,
  locale,
  tone = "paper",
  cellClassName = "px-4 py-5",
  className,
}: InventoryFiguresProps) {
  const cell = tone === "paper" ? "bg-paper" : "bg-surface"
  const numbers = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US")
  return (
    <div className={className}>
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.figuresLabel}</p>
      <dl
        data-slot="inventory"
        // Seven cells on two or four columns leave one open track, which would
        // show the hairline ground as a grey slab. The last cell spans it closed.
        className="mt-4 grid grid-cols-2 gap-px border-y border-hairline bg-hairline lg:grid-cols-4 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-2"
      >
        {INVENTORY_KEYS.map((key) => {
          const figure = inventoryFigure(inventory, key)
          return (
            <div
              key={key}
              data-figure={key}
              className={`trace flex flex-col gap-2 ${cellClassName} ${cell}`}
            >
              <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                {copy.figures[key]}
              </dt>
              <dd className="text-3xl font-medium tabular-nums tracking-tight text-ink">
                {figure === null ? "\u2014" : numbers.format(figure)}
              </dd>
            </div>
          )
        })}
      </dl>
      <p className="mt-3 text-sm text-muted">{copy.figuresNote}</p>
    </div>
  )
}
