/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
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
})
