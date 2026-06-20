/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentTree } from "./subagent-tree"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/components/ui/collapsible")

const part = (over: Partial<SubagentPartType> & { subagentId: string }): SubagentPartType => ({
  type: "subagent",
  parentSessionId: "p",
  name: over.subagentId,
  status: "completed",
  progress: 100,
  startedAt: 0,
  ...over,
})

beforeEach(() => {
  useSubagentRuntimeStore.setState((s) => ({ ...s, subAgents: {} }))
})

describe("SubagentTree", () => {
  it("renders nothing when there are no subagent parts", () => {
    const { container } = render(<SubagentTree parts={[{ type: "text", text: "hi" }] as never} />)
    expect(container.querySelector('[data-testid="subagent-tree"]')).toBeNull()
  })

  it("renders a 3-level tree with every node card present and nested", () => {
    render(
      <SubagentTree
        parts={
          [
            part({ subagentId: "a", startedAt: 1 }),
            part({ subagentId: "b", parentSubagentId: "a", startedAt: 2 }),
            part({ subagentId: "c", parentSubagentId: "b", startedAt: 3 }),
          ] as never
        }
      />
    )
    expect(screen.getByTestId("subagent-part-a")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-part-b")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-part-c")).toBeInTheDocument()
    // c is nested under b which is nested under a.
    const nodeA = screen.getByTestId("subagent-tree-node-a")
    expect(nodeA.querySelector('[data-testid="subagent-tree-node-b"]')).not.toBeNull()
    const nodeB = screen.getByTestId("subagent-tree-node-b")
    expect(nodeB.querySelector('[data-testid="subagent-tree-node-c"]')).not.toBeNull()
  })

  it("renders sibling fan-out under one parent", () => {
    render(
      <SubagentTree
        parts={
          [
            part({ subagentId: "a", startedAt: 1 }),
            part({ subagentId: "c1", parentSubagentId: "a", startedAt: 2 }),
            part({ subagentId: "c2", parentSubagentId: "a", startedAt: 3 }),
          ] as never
        }
      />
    )
    const nodeA = screen.getByTestId("subagent-tree-node-a")
    expect(nodeA.querySelector('[data-testid="subagent-tree-node-c1"]')).not.toBeNull()
    expect(nodeA.querySelector('[data-testid="subagent-tree-node-c2"]')).not.toBeNull()
  })

  it("degrades to a single card when there are no children", () => {
    render(<SubagentTree parts={[part({ subagentId: "solo" })] as never} />)
    expect(screen.getByTestId("subagent-part-solo")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-tree")).toBeInTheDocument()
  })

  describe("mode + expand-all", () => {
    const twoNodes = [
      part({ subagentId: "a", startedAt: 1 }),
      part({ subagentId: "b", startedAt: 2 }),
    ]

    it("threads the active mode onto the tree container", () => {
      render(<SubagentTree parts={twoNodes as never} mode="simplified" />)
      expect(screen.getByTestId("subagent-tree").dataset.mode).toBe("simplified")
    })

    it("shows the expand-all control only when there are ≥2 nodes", () => {
      const { rerender } = render(<SubagentTree parts={twoNodes as never} />)
      expect(screen.getByTestId("subagent-tree-expand-all")).toBeInTheDocument()
      rerender(<SubagentTree parts={[part({ subagentId: "solo" })] as never} />)
      expect(screen.queryByTestId("subagent-tree-expand-all")).toBeNull()
    })

    it("detailed mode opens every node by default", () => {
      const { container } = render(<SubagentTree parts={twoNodes as never} mode="detailed" />)
      expect(container.querySelectorAll('[data-open="true"]').length).toBe(2)
    })

    it("expand-all opens all nodes, collapse-all closes them", () => {
      const { container } = render(<SubagentTree parts={twoNodes as never} mode="standard" />)
      expect(container.querySelectorAll('[data-open="true"]').length).toBe(0)
      fireEvent.click(screen.getByTestId("subagent-tree-expand-all"))
      expect(container.querySelectorAll('[data-open="true"]').length).toBe(2)
      fireEvent.click(screen.getByTestId("subagent-tree-expand-all"))
      expect(container.querySelectorAll('[data-open="true"]').length).toBe(0)
    })

    it("renders simplified rows when mode is simplified", () => {
      render(<SubagentTree parts={twoNodes as never} mode="simplified" />)
      // Simplified rows expose an aria-expanded toggle (no Collapsible card).
      expect(screen.getByTestId("subagent-toggle-a").getAttribute("aria-expanded")).toBe("false")
    })

    it("toggles a single node independently of its siblings", () => {
      render(<SubagentTree parts={twoNodes as never} mode="simplified" />)
      fireEvent.click(screen.getByTestId("subagent-toggle-a"))
      expect(screen.getByTestId("subagent-toggle-a").getAttribute("aria-expanded")).toBe("true")
      // Sibling b stays collapsed — per-node override, not a global flag.
      expect(screen.getByTestId("subagent-toggle-b").getAttribute("aria-expanded")).toBe("false")
    })
  })
})
