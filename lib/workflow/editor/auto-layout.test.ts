/**
 * @jest-environment jsdom
 */

/**
 * `autoLayout` had no co-located test, which is how `elk.direction` stayed
 * hard-pinned to `RIGHT` while `wf_auto_layout` advertised an LR/TB/RL/BT
 * `direction` parameter to the model and silently discarded it.
 *
 * elkjs is mocked so the assertions are about the layout options we hand it,
 * not about elk's own placement maths.
 */

const layoutMock = jest.fn(async (graph: { children?: Array<{ id: string }> }) => ({
  children: (graph.children ?? []).map((child, index) => ({
    ...child,
    x: index * 10,
    y: index * 20,
  })),
}))

jest.mock("elkjs/lib/elk.bundled.js", () => ({
  __esModule: true,
  default: class {
    layout = layoutMock
  },
}))

import { autoLayout, ELK_DIRECTIONS, applyAutoLayoutPositions } from "./auto-layout"
import type { RFWorkflowEdge, RFWorkflowNode } from "./react-flow-converter"

const node = (id: string): RFWorkflowNode =>
  ({
    id,
    type: "ai.prompt",
    position: { x: 0, y: 0 },
    data: {},
  }) as unknown as RFWorkflowNode

const nodes = [node("a"), node("b")]
const edges: RFWorkflowEdge[] = []

function lastLayoutOptions(): Record<string, string> {
  const call = layoutMock.mock.calls.at(-1)?.[0] as { layoutOptions: Record<string, string> }
  return call.layoutOptions
}

beforeEach(() => layoutMock.mockClear())

describe("autoLayout direction", () => {
  it("defaults to RIGHT when no direction is given", async () => {
    await autoLayout(nodes, edges)
    expect(lastLayoutOptions()["elk.direction"]).toBe("RIGHT")
  })

  it.each(Object.entries(ELK_DIRECTIONS))("maps %s onto elk %s", async (input, expected) => {
    await autoLayout(nodes, edges, { direction: input as keyof typeof ELK_DIRECTIONS })
    expect(lastLayoutOptions()["elk.direction"]).toBe(expected)
  })

  it("keeps the rest of the default layout options intact", async () => {
    await autoLayout(nodes, edges, { direction: "TB" })
    const options = lastLayoutOptions()
    expect(options["elk.algorithm"]).toBe("layered")
    expect(options["elk.spacing.nodeNode"]).toBe("60")
  })

  it("returns positions keyed by node id", async () => {
    const result = await autoLayout(nodes, edges)
    expect(result).toEqual({ a: { x: 0, y: 0 }, b: { x: 10, y: 20 } })
    const moved = applyAutoLayoutPositions(nodes, result)
    expect(moved.find((n) => n.id === "b")?.position).toEqual({ x: 10, y: 20 })
  })

  it("no-ops on an empty graph without calling elk", async () => {
    expect(await autoLayout([], edges)).toEqual({})
    expect(layoutMock).not.toHaveBeenCalled()
  })
})
