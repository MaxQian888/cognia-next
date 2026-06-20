/**
 * A2UI Page Assembler — deterministic component factories for the
 * "interactive page from execution" bridge (workflow runs, conversations).
 *
 * Why this exists: turning an execution source into an A2UI app means emitting
 * dozens of valid `A2UIComponent` literals with unique, stable ids and correct
 * container/child wiring. Hand-writing those literals in each projector is
 * noisy and error-prone. `PageAssembler` owns id generation + the component
 * array, so projectors read as a flat list of "add this card, add this chart".
 *
 * Determinism: ids are per-prefix counters (`text-1`, `card-2`) — no
 * `Date.now()` / `Math.random()` — so the same source always yields the same
 * component tree, which is exactly what the co-located tests assert.
 */

import type {
  A2UIAlertVariant,
  A2UIChartDataPoint,
  A2UIChartType,
  A2UIComponent,
  A2UITableColumn,
  A2UITextVariant,
} from "@/types/a2ui/schema"

/** Per-prefix monotonic id generator. Pure + deterministic. */
export class IdGen {
  private readonly counters = new Map<string, number>()

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, n)
    return `${prefix}-${n}`
  }
}

export interface CardOptions {
  title?: string
  description?: string
  childrenIds: string[]
}

export interface ColumnOptions {
  gap?: number | string
  align?: "start" | "center" | "end" | "stretch"
}

export interface RowOptions {
  gap?: number | string
  align?: "start" | "center" | "end" | "stretch"
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly"
  wrap?: boolean
}

export interface ChartOptions {
  title?: string
  height?: number
  showLegend?: boolean
  showGrid?: boolean
  xKey?: string
  yKeys?: string[]
}

/**
 * Accumulates A2UI components for a single surface. Every `add*` returns the
 * new component's id so callers can wire it into a later container; container
 * methods (`card`, `column`, `row`) take already-built child ids.
 */
export class PageAssembler {
  readonly components: A2UIComponent[] = []
  private readonly ids = new IdGen()

  private push(component: A2UIComponent): string {
    this.components.push(component)
    return component.id
  }

  text(
    value: string,
    opts: { variant?: A2UITextVariant; align?: "left" | "center" | "right" } = {}
  ): string {
    return this.push({
      id: this.ids.next("text"),
      component: "Text",
      text: value,
      variant: opts.variant,
      align: opts.align,
    })
  }

  badge(value: string, variant?: "default" | "secondary" | "destructive" | "outline"): string {
    return this.push({
      id: this.ids.next("badge"),
      component: "Badge",
      text: value,
      variant,
    })
  }

  divider(text?: string): string {
    return this.push({
      id: this.ids.next("divider"),
      component: "Divider",
      orientation: "horizontal",
      text,
    })
  }

  alert(opts: { title?: string; message: string; variant?: A2UIAlertVariant }): string {
    return this.push({
      id: this.ids.next("alert"),
      component: "Alert",
      title: opts.title,
      message: opts.message,
      variant: opts.variant,
      showIcon: true,
    })
  }

  table(
    columns: A2UITableColumn[],
    data: Record<string, unknown>[],
    opts: { title?: string } = {}
  ): string {
    return this.push({
      id: this.ids.next("table"),
      component: "Table",
      columns,
      data,
      title: opts.title,
    })
  }

  chart(chartType: A2UIChartType, data: A2UIChartDataPoint[], opts: ChartOptions = {}): string {
    return this.push({
      id: this.ids.next("chart"),
      component: "Chart",
      chartType,
      data,
      title: opts.title,
      height: opts.height,
      showLegend: opts.showLegend,
      showGrid: opts.showGrid,
      xKey: opts.xKey,
      yKeys: opts.yKeys,
    })
  }

  column(childrenIds: string[], opts: ColumnOptions = {}): string {
    return this.push({
      id: this.ids.next("column"),
      component: "Column",
      children: childrenIds,
      gap: opts.gap ?? 2,
      align: opts.align,
    })
  }

  row(childrenIds: string[], opts: RowOptions = {}): string {
    return this.push({
      id: this.ids.next("row"),
      component: "Row",
      children: childrenIds,
      gap: opts.gap ?? 2,
      align: opts.align,
      justify: opts.justify,
      wrap: opts.wrap ?? true,
    })
  }

  card(opts: CardOptions): string {
    return this.push({
      id: this.ids.next("card"),
      component: "Card",
      title: opts.title,
      description: opts.description,
      children: opts.childrenIds,
    })
  }

  /**
   * The surface's top-level container. MUST be emitted exactly once with the
   * literal id `"root"` — the A2UI store defaults a surface's `rootId` to
   * `"root"`, so any other id renders an empty surface. Returns `"root"`.
   */
  root(childrenIds: string[], opts: ColumnOptions = {}): string {
    return this.push({
      id: "root",
      component: "Column",
      children: childrenIds,
      gap: opts.gap ?? 3,
      align: opts.align,
    })
  }

  /**
   * A compact metric tile: a card wrapping a value (heading) + label (caption).
   * Returns the card id so the caller can place several in a `row`.
   */
  kpi(label: string, value: string, hint?: string): string {
    const valueId = this.text(value, { variant: "heading3" })
    const labelId = this.text(label, { variant: "caption" })
    const childIds = hint
      ? [valueId, labelId, this.text(hint, { variant: "caption" })]
      : [valueId, labelId]
    const colId = this.column(childIds, { gap: 1 })
    return this.card({ childrenIds: [colId] })
  }
}
