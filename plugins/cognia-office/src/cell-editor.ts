/**
 * In-place cell editing for the workbook preview.
 *
 * Humans and agents work in the same file: a person who spots one wrong
 * number fixes it where they see it, through the same committed, versioned,
 * recalculated path the agent's `office_apply_operations` takes. The scope is
 * deliberately value/formula entry on one cell at a time — no structural
 * edits, no formatting toolbar; this is not a spreadsheet application.
 *
 * The editor decorates the table `preview.ts` renders instead of rendering
 * cells itself: it turns the table into an ARIA grid (one tab stop, the
 * active cell tracked with `aria-activedescendant`), and handles keys and
 * pointer events by delegation. Edit state lives here, not in the DOM, so a
 * re-render mid-edit (a locale switch, an agent update) keeps the draft.
 *
 * Keys, as in Excel: arrows move; Enter / F2 / double-click edit; typing a
 * character starts an edit with it; Delete / Backspace clear the contents
 * (formatting stays). While editing, Enter commits and moves down, Tab
 * commits and moves right (Shift reverses both), Escape cancels, and leaving
 * the field commits.
 */

import { decodeCell, encodeCell } from "./a1"
import type { WorkbookCell, WorkbookOperation, WorkbookSheet } from "./model"
import type { PreviewTranslator } from "./preview"

/** What typing `input` into a cell holding `existing` changes, or null for nothing. */
export function cellEditOperations(
  sheet: string,
  ref: string,
  input: string,
  existing: WorkbookCell | undefined
): WorkbookOperation[] | null {
  if (input === cellInputText(existing)) return null
  if (input.trim() === "") {
    if (!existing || (existing.value === undefined && !existing.formula)) return null
    return [{ op: "clearRange", sheet, range: ref, target: "contents" }]
  }
  const style = existing?.style ? { style: existing.style } : {}
  return [
    { op: "setCell", sheet, cell: ref, value: { ...parseCellInput(input, existing), ...style } },
  ]
}

/**
 * A typed entry as a cell, following Excel's conventions: `=` starts a
 * formula (its value is computed on commit), a leading apostrophe forces
 * text, then numbers, TRUE / FALSE, and ISO dates (`2024-01-31`) are
 * recognized; anything else is text.
 */
export function parseCellInput(input: string, existing?: WorkbookCell): WorkbookCell {
  if (input.startsWith("=") && input.trim().length > 1) {
    // A formula keeps a date type so its computed serial displays as a date.
    return { type: existing?.type === "date" ? "date" : "number", formula: input.slice(1).trim() }
  }
  if (input.startsWith("'")) return { type: "string", value: input.slice(1) }
  const text = input.trim()
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return { type: "number", value: Number(text) }
  }
  const upper = text.toUpperCase()
  if (upper === "TRUE" || upper === "FALSE") return { type: "boolean", value: upper === "TRUE" }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])]
    const parsed = new Date(year, month, day)
    if (parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day)
      return { type: "date", value: parsed.toISOString() }
  }
  return { type: "string", value: input }
}

/** The text an edit field starts from: the formula when there is one, else the raw value. */
export function cellInputText(cell: WorkbookCell | undefined): string {
  if (!cell) return ""
  if (cell.formula) return `=${cell.formula}`
  if (cell.value === undefined) return ""
  if (cell.type === "date") {
    const date = new Date(String(cell.value))
    if (Number.isNaN(date.getTime())) return String(cell.value)
    const pad = (value: number) => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  if (cell.type === "boolean") return cell.value ? "TRUE" : "FALSE"
  // Text that would read back as another type keeps Excel's apostrophe.
  if (cell.type === "string" && parseCellInput(String(cell.value)).type !== "string")
    return `'${String(cell.value)}`
  return String(cell.value)
}

export interface CellEditorDeps {
  t: PreviewTranslator
  /** Commit operations against the current artifact version; rejects on failure. */
  commit: (operations: WorkbookOperation[]) => Promise<unknown>
  /** Re-render the preview (the editor's state changed). */
  render: () => void
  isDisposed: () => boolean
}

export interface CellEditor {
  /** Turn a freshly rendered sheet table (`rows` × `columns` rendered cells) into the editable grid. */
  decorate: (
    table: HTMLTableElement,
    sheet: WorkbookSheet,
    rendered: { rows: number; columns: number }
  ) => void
  /** The saving / failure line, or null when there is nothing to say. */
  renderStatus: () => HTMLElement | null
  /** A different sheet is shown: drop the active cell and any draft. */
  reset: () => void
}

type Move = "up" | "down" | "left" | "right"

const MOVES: Record<Move, { r: number; c: number }> = {
  up: { r: -1, c: 0 },
  down: { r: 1, c: 0 },
  left: { r: 0, c: -1 },
  right: { r: 0, c: 1 },
}

export function createCellEditor(deps: CellEditorDeps): CellEditor {
  const { t } = deps
  let active: string | null = null
  let editing: { ref: string; draft: string } | null = null
  let pending = false
  let error: string | null = null
  // Refreshed on every decorate: the cells the draft is committed against.
  let sheet: WorkbookSheet | null = null

  const commit = (operations: WorkbookOperation[] | null) => {
    if (!operations || pending) return
    pending = true
    error = null
    deps.render()
    Promise.resolve()
      .then(() => deps.commit(operations))
      .then(
        () => {
          pending = false
        },
        (failure: unknown) => {
          pending = false
          const message = failure instanceof Error ? failure.message : String(failure)
          error = /version conflict/i.test(message)
            ? t("edit.conflict")
            : t("edit.failed", { error: message })
        }
      )
      .finally(() => {
        if (!deps.isDisposed()) deps.render()
      })
  }

  const finishEdit = (move: Move | null) => {
    if (!editing || !sheet) return
    const { ref, draft } = editing
    editing = null
    if (move) active = neighbour(ref, move) ?? ref
    commit(cellEditOperations(sheet.title, ref, draft, sheet.cells[ref]))
    deps.render()
  }

  // Resolved against the latest decorate's table and bounds, so a move skips
  // cells a merge covers or a hidden row/column removes.
  let currentTable: HTMLTableElement | null = null
  let bounds = { rows: 0, columns: 0 }
  const cellElement = (ref: string) =>
    currentTable?.querySelector<HTMLTableCellElement>(`td[data-ref="${ref}"]`) ?? null
  const neighbour = (ref: string, move: Move): string | null => {
    const step = MOVES[move]
    let { r, c } = decodeCell(ref)
    for (;;) {
      r += step.r
      c += step.c
      if (r < 0 || c < 0 || r >= bounds.rows || c >= bounds.columns) return null
      const candidate = encodeCell({ r, c })
      const element = cellElement(candidate)
      if (element && !element.closest("tr")?.hidden) return candidate
    }
  }

  const activate = (ref: string, focus: boolean) => {
    active = ref
    deps.render()
    if (focus) currentTable?.focus({ preventScroll: true })
    cellElement(ref)?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }

  const startEdit = (ref: string, draft?: string) => {
    if (pending || !sheet) return
    active = ref
    editing = { ref, draft: draft ?? cellInputText(sheet.cells[ref]) }
    deps.render()
  }

  return {
    reset: () => {
      active = null
      editing = null
    },

    renderStatus: () => {
      if (!pending && !error) return null
      const line = document.createElement("p")
      line.className = "copv-edit-status"
      line.setAttribute("role", error ? "alert" : "status")
      line.textContent = error ?? t("edit.saving")
      return line
    },

    decorate: (table, nextSheet, rendered) => {
      sheet = nextSheet
      currentTable = table
      bounds = rendered
      if (active && !cellElement(active)) active = null
      if (editing && !cellElement(editing.ref)) editing = null
      active ??= table.querySelector<HTMLTableCellElement>("td[data-ref]")?.dataset.ref ?? null

      table.setAttribute("role", "grid")
      table.setAttribute("aria-label", t("edit.grid", { name: nextSheet.title }))
      table.setAttribute("aria-busy", String(pending))
      table.tabIndex = 0
      table.dataset.focusKey = "grid"
      for (const td of table.querySelectorAll<HTMLTableCellElement>("td[data-ref]")) {
        td.id = `${table.id}-${td.dataset.ref}`
        td.setAttribute("role", "gridcell")
      }
      const current = active ? cellElement(active) : null
      if (current) {
        current.classList.add("copv-cell--active")
        current.setAttribute("aria-selected", "true")
        table.setAttribute("aria-activedescendant", current.id)
      }

      if (editing && current) {
        const input = document.createElement("input")
        input.className = "copv-cell-input"
        input.value = editing.draft
        input.dataset.focusKey = "cell-input"
        input.setAttribute("aria-label", t("edit.input", { cell: editing.ref }))
        input.spellcheck = false
        input.addEventListener("input", () => {
          if (editing) editing.draft = input.value
        })
        input.addEventListener("keydown", (event) => {
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            finishEdit(event.shiftKey ? "up" : "down")
            currentTable?.focus({ preventScroll: true })
          } else if (event.key === "Tab") {
            event.preventDefault()
            finishEdit(event.shiftKey ? "left" : "right")
            currentTable?.focus({ preventScroll: true })
          } else if (event.key === "Escape") {
            event.preventDefault()
            editing = null
            deps.render()
            currentTable?.focus({ preventScroll: true })
          }
        })
        // Leaving the field commits, like clicking another cell in Excel. A
        // re-render detaches the input first, which is not a user leaving.
        input.addEventListener("blur", () => {
          if (input.isConnected && editing) finishEdit(null)
        })
        current.replaceChildren(input)
        queueMicrotask(() => {
          if (input.isConnected && document.activeElement !== input) {
            input.focus({ preventScroll: true })
            input.setSelectionRange(input.value.length, input.value.length)
          }
        })
      }

      table.addEventListener("click", (event) => {
        const td = (event.target as HTMLElement).closest<HTMLTableCellElement>("td[data-ref]")
        if (td?.dataset.ref && td.dataset.ref !== editing?.ref) activate(td.dataset.ref, true)
      })
      table.addEventListener("dblclick", (event) => {
        const td = (event.target as HTMLElement).closest<HTMLTableCellElement>("td[data-ref]")
        if (td?.dataset.ref) startEdit(td.dataset.ref)
      })
      table.addEventListener("keydown", (event) => {
        if (!active || event.target !== table) return
        const move: Move | undefined = (
          { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const
        )[event.key as "ArrowUp"]
        if (move) {
          event.preventDefault()
          const next = neighbour(active, move)
          if (next) activate(next, true)
          return
        }
        if (event.key === "Enter" || event.key === "F2") {
          event.preventDefault()
          startEdit(active)
        } else if ((event.key === "Delete" || event.key === "Backspace") && sheet) {
          event.preventDefault()
          commit(cellEditOperations(sheet.title, active, "", sheet.cells[active]))
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          startEdit(active, event.key)
        }
      })
    },
  }
}
