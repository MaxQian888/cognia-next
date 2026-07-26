import { remarkLlmUnwrap } from "./remark-llm-unwrap"

type TestNode = {
  type: string
  name?: string | null
  data?: { _stringify?: unknown; keep?: boolean }
  children?: TestNode[]
}

function jsx(name: string, extra: Partial<TestNode> = {}): TestNode {
  return { type: "mdxJsxFlowElement", name, children: [], ...extra }
}

function run(tree: TestNode): TestNode {
  remarkLlmUnwrap()(tree)
  return tree
}

describe("remarkLlmUnwrap", () => {
  it("marks presentational wrappers as children-only", () => {
    const tree = run({ type: "root", children: [jsx("TLDR")] })
    expect(tree.children?.[0].data?._stringify).toBe("children-only")
  })

  it("leaves components whose attributes carry information untouched", () => {
    const tree = run({
      type: "root",
      children: [jsx("Mermaid"), jsx("Status"), jsx("Term"), jsx("Stat")],
    })
    for (const child of tree.children ?? []) {
      expect(child.data?._stringify).toBeUndefined()
    }
  })

  it("unwraps nested wrappers, not just top-level ones", () => {
    const tree = run({
      type: "root",
      children: [jsx("Steps", { children: [jsx("Step"), jsx("Status")] })],
    })
    const steps = tree.children?.[0]
    expect(steps?.data?._stringify).toBe("children-only")
    expect(steps?.children?.[0].data?._stringify).toBe("children-only")
    expect(steps?.children?.[1].data?._stringify).toBeUndefined()
  })

  it("handles inline JSX elements too", () => {
    const tree = run({
      type: "root",
      children: [{ type: "mdxJsxTextElement", name: "Kbd", children: [] }],
    })
    expect(tree.children?.[0].data?._stringify).toBe("children-only")
  })

  it("preserves existing node data", () => {
    const tree = run({
      type: "root",
      children: [jsx("TLDR", { data: { keep: true } })],
    })
    expect(tree.children?.[0].data).toEqual({ keep: true, _stringify: "children-only" })
  })

  it("ignores non-JSX nodes and unnamed elements", () => {
    const tree = run({
      type: "root",
      children: [
        { type: "paragraph", children: [] },
        { type: "mdxJsxFlowElement", name: null, children: [] },
      ],
    })
    for (const child of tree.children ?? []) {
      expect(child.data?._stringify).toBeUndefined()
    }
  })
})
