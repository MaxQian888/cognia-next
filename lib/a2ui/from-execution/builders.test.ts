import { IdGen, PageAssembler } from "./builders"

describe("IdGen", () => {
  it("produces monotonic per-prefix ids", () => {
    const ids = new IdGen()
    expect(ids.next("text")).toBe("text-1")
    expect(ids.next("text")).toBe("text-2")
    expect(ids.next("card")).toBe("card-1")
    expect(ids.next("text")).toBe("text-3")
  })
})

describe("PageAssembler", () => {
  it("emits typed components with unique ids and returns each id", () => {
    const a = new PageAssembler()
    const t = a.text("Hello", { variant: "heading2" })
    const b = a.badge("ok", "default")
    expect(t).toBe("text-1")
    expect(b).toBe("badge-1")
    expect(a.components).toHaveLength(2)
    expect(a.components[0]).toMatchObject({
      id: "text-1",
      component: "Text",
      text: "Hello",
      variant: "heading2",
    })
    expect(a.components[1]).toMatchObject({ id: "badge-1", component: "Badge", text: "ok" })
  })

  it("wires containers to child ids", () => {
    const a = new PageAssembler()
    const c1 = a.text("a")
    const c2 = a.text("b")
    const row = a.row([c1, c2], { justify: "between" })
    const col = a.column([row])
    const card = a.card({ title: "T", childrenIds: [col] })
    expect(a.components.find((c) => c.id === row)).toMatchObject({
      component: "Row",
      children: [c1, c2],
    })
    expect(a.components.find((c) => c.id === col)).toMatchObject({
      component: "Column",
      children: [row],
    })
    expect(a.components.find((c) => c.id === card)).toMatchObject({
      component: "Card",
      title: "T",
      children: [col],
    })
  })

  it("builds tables and charts with their data", () => {
    const a = new PageAssembler()
    a.table([{ key: "k", header: "H" }], [{ k: 1 }], { title: "Tbl" })
    a.chart("bar", [{ name: "x", value: 5 }], { title: "C", height: 200 })
    expect(a.components[0]).toMatchObject({ component: "Table", title: "Tbl", data: [{ k: 1 }] })
    expect(a.components[1]).toMatchObject({
      component: "Chart",
      chartType: "bar",
      title: "C",
      height: 200,
    })
  })

  it("kpi composes a card around value + label texts", () => {
    const a = new PageAssembler()
    const card = a.kpi("Steps", "5", "hint")
    const cardComp = a.components.find((c) => c.id === card) as {
      component: string
      children: string[]
    }
    expect(cardComp.component).toBe("Card")
    // card → column → [value, label, hint]
    const col = a.components.find((c) => c.id === cardComp.children[0]) as { children: string[] }
    expect(col.children).toHaveLength(3)
    const value = a.components.find((c) => c.id === col.children[0]) as {
      text: string
      variant: string
    }
    expect(value).toMatchObject({ text: "5", variant: "heading3" })
  })

  it("root is emitted exactly once with the literal id 'root'", () => {
    const a = new PageAssembler()
    const t = a.text("x")
    a.root([t])
    const roots = a.components.filter((c) => c.id === "root")
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ component: "Column", children: [t] })
  })

  it("alert sets icon + variant", () => {
    const a = new PageAssembler()
    a.alert({ title: "E", message: "boom", variant: "error" })
    expect(a.components[0]).toMatchObject({
      component: "Alert",
      message: "boom",
      variant: "error",
      showIcon: true,
    })
  })

  it("divider carries optional label", () => {
    const a = new PageAssembler()
    a.divider("Section")
    expect(a.components[0]).toMatchObject({
      component: "Divider",
      orientation: "horizontal",
      text: "Section",
    })
  })
})
