import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SelectList } from "./SelectList"

// jsdom has no Yoga layout, so stub the absolute-position reader for click tests.
jest.mock("../input/element-position", () => ({
  absoluteTopLeft: () => ({ top: 0, left: 0 }),
}))

const items = [{ label: "One", hint: "first" }, { label: "Two" }, { label: "Three" }]

describe("SelectList", () => {
  beforeEach(() => __resetInk())

  it("renders items with the highlighted row and hints", () => {
    const { container } = render(
      <SelectList title="Pick" items={items} index={1} onMove={() => {}} onSelect={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Pick")
    expect(text).toContain("One")
    expect(text).toContain("first")
    expect(text).toContain("❯ Two")
  })

  it("moves on arrow keys and selects on Enter", () => {
    const onMove = jest.fn()
    const onSelect = jest.fn()
    render(<SelectList items={items} index={0} onMove={onMove} onSelect={onSelect} />)
    __fireInput("", { downArrow: true })
    __fireInput("", { upArrow: true })
    __fireInput("", { return: true })
    expect(onMove).toHaveBeenNthCalledWith(1, 1)
    expect(onMove).toHaveBeenNthCalledWith(2, -1)
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it("cancels on Escape", () => {
    const onCancel = jest.fn()
    render(
      <SelectList
        items={items}
        index={0}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={onCancel}
      />
    )
    __fireInput("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("does nothing on Escape without an onCancel handler", () => {
    render(<SelectList items={items} index={0} onMove={() => {}} onSelect={() => {}} />)
    expect(() => __fireInput("", { escape: true })).not.toThrow()
  })

  it("shows the default key-hint footer, and hides it when footerHint is false", () => {
    const withFooter = render(
      <SelectList items={items} index={0} onMove={() => {}} onSelect={() => {}} />
    )
    expect(withFooter.container.textContent ?? "").toContain("Enter select")
    __resetInk()
    const without = render(
      <SelectList
        items={items}
        index={0}
        onMove={() => {}}
        onSelect={() => {}}
        footerHint={false}
      />
    )
    expect(without.container.textContent ?? "").not.toContain("Enter select")
  })

  it("selects the clicked row (highlight + select) in scroll mouse mode", () => {
    const onMove = jest.fn()
    const onSelect = jest.fn()
    // No title → headerRows 0; border 1 → first item at 0-based row 1 (SGR row 2).
    render(<SelectList items={items} index={0} onMove={onMove} onSelect={onSelect} />)
    __fireInput("[<0;3;3M", {}) // SGR row 3 → 0-based 2 → item offset 1 (Two)
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(onMove).toHaveBeenCalledWith(1) // move highlight from index 0 to 1
  })

  it("moves the highlight on the mouse wheel", () => {
    const onMove = jest.fn()
    render(<SelectList items={items} index={1} onMove={onMove} onSelect={() => {}} />)
    __fireInput("[<64;1;1M", {}) // wheel up
    __fireInput("[<65;1;1M", {}) // wheel down
    expect(onMove).toHaveBeenNthCalledWith(1, -1)
    expect(onMove).toHaveBeenNthCalledWith(2, 1)
  })

  it("swallows the wheel without moving the highlight when disableWheel is set", () => {
    const onMove = jest.fn()
    render(<SelectList items={items} index={1} onMove={onMove} onSelect={() => {}} disableWheel />)
    __fireInput("[<64;1;1M", {}) // wheel up
    __fireInput("[<65;1;1M", {}) // wheel down
    expect(onMove).not.toHaveBeenCalled()
  })

  it("ignores a click on the border/title without selecting", () => {
    const onSelect = jest.fn()
    render(
      <SelectList title="Pick" items={items} index={0} onMove={() => {}} onSelect={onSelect} />
    )
    __fireInput("[<0;1;1M", {}) // SGR row 1 → 0-based 0 = the top border
    expect(onSelect).not.toHaveBeenCalled()
  })

  describe("searchable (typeahead)", () => {
    it("renders the search line with a placeholder while the query is empty", () => {
      const { container } = render(
        <SelectList
          items={items}
          index={0}
          query=""
          onQueryChange={() => {}}
          searchPlaceholder="type to filter models"
          onMove={() => {}}
          onSelect={() => {}}
        />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("🔎")
      expect(text).toContain("type to filter models")
    })

    it("shows the current query instead of the placeholder", () => {
      const { container } = render(
        <SelectList
          items={items}
          index={0}
          query="opus"
          onQueryChange={() => {}}
          searchPlaceholder="type to filter models"
          onMove={() => {}}
          onSelect={() => {}}
        />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("opus")
      expect(text).not.toContain("type to filter models")
    })

    it("lazy search: hides the 🔎 row when searchRowVisible is false but still types", () => {
      const onQueryChange = jest.fn()
      const { container } = render(
        <SelectList
          items={items}
          index={0}
          query=""
          searchRowVisible={false}
          onQueryChange={onQueryChange}
          onMove={() => {}}
          onSelect={() => {}}
        />
      )
      expect(container.textContent ?? "").not.toContain("🔎")
      __fireInput("t", {})
      expect(onQueryChange).toHaveBeenCalledWith("t")
    })

    it("appends printable keys and trims on backspace", () => {
      const onQueryChange = jest.fn()
      render(
        <SelectList
          items={items}
          index={0}
          query="op"
          onQueryChange={onQueryChange}
          onMove={() => {}}
          onSelect={() => {}}
        />
      )
      __fireInput("u", {})
      expect(onQueryChange).toHaveBeenLastCalledWith("opu")
      __fireInput("", { backspace: true })
      expect(onQueryChange).toHaveBeenLastCalledWith("o")
    })

    it("keeps arrows/Enter/Esc as list controls (not typed into the query)", () => {
      const onMove = jest.fn()
      const onSelect = jest.fn()
      const onCancel = jest.fn()
      const onQueryChange = jest.fn()
      render(
        <SelectList
          items={items}
          index={0}
          query=""
          onQueryChange={onQueryChange}
          onMove={onMove}
          onSelect={onSelect}
          onCancel={onCancel}
        />
      )
      __fireInput("", { downArrow: true })
      __fireInput("", { return: true })
      __fireInput("", { escape: true })
      expect(onMove).toHaveBeenCalledWith(1)
      expect(onSelect).toHaveBeenCalledWith(0)
      expect(onCancel).toHaveBeenCalled()
      expect(onQueryChange).not.toHaveBeenCalled()
    })

    it("shows the empty hint when a search filters everything out", () => {
      const { container } = render(
        <SelectList
          items={[]}
          index={0}
          query="zzz"
          onQueryChange={() => {}}
          emptyHint="no models match"
          onMove={() => {}}
          onSelect={() => {}}
        />
      )
      expect(container.textContent ?? "").toContain("no models match")
    })
  })

  it("windows a long list around the selection with scroll hints", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i}` }))
    const { container } = render(
      <SelectList items={many} index={20} maxRows={5} onMove={() => {}} onSelect={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("❯ Item 20") // selection visible
    expect(text).toContain("↑") // hidden rows above
    expect(text).toContain("↓") // hidden rows below
    expect(text).not.toContain("Item 0") // scrolled out of view
  })
})

describe("SelectList — wrapped-row viewport", () => {
  const longLabels = Array.from({ length: 8 }, (_, i) => `option-${i} ${"x".repeat(60)}`)

  it("shows fewer items when the labels wrap, so the row cap is never exceeded", () => {
    const narrow = render(
      <SelectList
        items={longLabels.map((label) => ({ label }))}
        index={0}
        maxRows={4}
        width={30}
        onMove={() => {}}
        onSelect={() => {}}
      />
    )
    const wide = render(
      <SelectList
        items={longLabels.map((label) => ({ label }))}
        index={0}
        maxRows={4}
        width={200}
        onMove={() => {}}
        onSelect={() => {}}
      />
    )
    const count = (frame: string) => longLabels.filter((l) => frame.includes(l.slice(0, 9))).length
    expect(count(narrow.container.textContent ?? "")).toBeLessThan(
      count(wide.container.textContent ?? "")
    )
  })

  it("keeps the highlighted row on screen at a narrow width", () => {
    const { container } = render(
      <SelectList
        items={longLabels.map((label) => ({ label }))}
        index={7}
        maxRows={4}
        width={30}
        onMove={() => {}}
        onSelect={() => {}}
      />
    )
    expect(container.textContent).toContain("option-7")
  })

  it("still shows the whole short list when nothing wraps", () => {
    const { container } = render(
      <SelectList
        items={[{ label: "one" }, { label: "two" }, { label: "three" }]}
        index={0}
        maxRows={6}
        width={40}
        onMove={() => {}}
        onSelect={() => {}}
      />
    )
    const frame = container.textContent ?? ""
    expect(frame).toContain("one")
    expect(frame).toContain("two")
    expect(frame).toContain("three")
  })
})
