/**
 * @jest-environment jsdom
 */
import fs from "node:fs"
import path from "node:path"
import { render, screen } from "@testing-library/react"
import {
  Field,
  FieldGroup,
  FieldRow,
  patchParam,
  readBoolean,
  readNumber,
  readString,
} from "./shared"

const FORMS_DIR = path.join(process.cwd(), "components/workflow/editor/inspector/forms")

function formSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx$/.test(entry.name) && !/\.test\.|\.stories\./.test(entry.name)) out.push(full)
    }
  }
  walk(FORMS_DIR)
  return out
}

describe("inspector form params readers", () => {
  it("coerces loosely-typed params and patches immutably", () => {
    const params = { a: "x", n: 3, s: "7", b: true }
    expect(readString(params, "a")).toBe("x")
    expect(readString(params, "missing", "fb")).toBe("fb")
    expect(readNumber(params, "n")).toBe(3)
    // Numeric strings round-trip — expression fields write strings.
    expect(readNumber(params, "s")).toBe(7)
    expect(readNumber(params, "a", 1)).toBe(1)
    expect(readBoolean(params, "b")).toBe(true)
    expect(readBoolean(params, "a", true)).toBe(true)

    const next = patchParam(params, "a", "y")
    expect(next).not.toBe(params)
    expect(next.a).toBe("y")
    expect(params.a).toBe("x")
  })
})

describe("FieldGroup / FieldRow layout", () => {
  it("declares the container the rows size against", () => {
    const { container } = render(
      <FieldGroup>
        <FieldRow>
          <Field label="One">
            <input aria-label="One" />
          </Field>
          <Field label="Two">
            <input aria-label="Two" />
          </Field>
        </FieldRow>
      </FieldGroup>
    )
    const group = container.firstElementChild as HTMLElement
    expect(group.className).toContain("@container/inspector-form")
    const row = group.firstElementChild as HTMLElement
    // Single column by default; the second column is earned at @xs so the
    // 240px-minimum inspector panel never shows two ~85px controls.
    expect(row.className).toContain("grid-cols-1")
    expect(row.className).toContain("@xs/inspector-form:grid-cols-2")
    expect(row.className).not.toContain("@sm/inspector-form:grid-cols-3")
  })

  it("earns a third column only at @sm", () => {
    const { container } = render(
      <FieldRow columns={3}>
        <span />
      </FieldRow>
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain("@xs/inspector-form:grid-cols-2")
    expect(row.className).toContain("@sm/inspector-form:grid-cols-3")
  })

  it("lets callers override the gap without losing the responsive columns", () => {
    const { container } = render(<FieldRow className="gap-2" />)
    const row = container.firstElementChild as HTMLElement
    // tailwind-merge keeps the caller's gap and drops the default `gap-3`.
    expect(row.className).toContain("gap-2")
    expect(row.className).not.toContain("gap-3")
    expect(row.className).toContain("@xs/inspector-form:grid-cols-2")
  })

  it("renders the required marker and the hint", () => {
    render(
      <Field label="Objective" hint="What the run should achieve" required>
        <input aria-label="Objective" />
      </Field>
    )
    expect(screen.getByText("Objective")).toBeInTheDocument()
    expect(screen.getByText("*")).toBeInTheDocument()
    expect(screen.getByText("What the run should achieve")).toBeInTheDocument()
  })
})

describe("no unconditional column grids in inspector forms", () => {
  /**
   * The inspector lives in the context workbench, draggable down to
   * `CONTEXT_WORKBENCH_MIN_WIDTH` (240px) and re-hosted inside a full-bleed
   * Sheet on mobile. A hard `grid-cols-2` there leaves ~85px per control,
   * which truncates every `<Select>` label. `FieldRow` is the only sanctioned
   * multi-column row; explicit `grid-cols-[…]` track lists (an input plus an
   * `auto` unit picker, say) stay allowed because they degrade gracefully.
   */
  it("routes every multi-column field row through FieldRow", () => {
    const offenders: string[] = []
    for (const file of formSourceFiles()) {
      const src = fs.readFileSync(file, "utf8")
      src.split("\n").forEach((line, i) => {
        if (!/\bgrid-cols-[2-9]\b/.test(line)) return
        // The definition of FieldRow itself, and any line that already pairs
        // the column count with a container query, are fine.
        if (/@(xs|sm|md|lg|xl)[/\w-]*:grid-cols/.test(line)) return
        offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it("actually scanned the form sources", () => {
    // Guards the sweep above from silently passing on an empty walk.
    expect(formSourceFiles().length).toBeGreaterThan(20)
  })
})
