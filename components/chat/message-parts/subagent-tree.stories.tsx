import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { SubagentTree } from "./subagent-tree"
import type { SubagentPart } from "@/lib/claude/parts-extensions"

const base = Date.now() - 1000 * 60 * 5

const node = (
  subagentId: string,
  name: string,
  status: SubagentPart["status"],
  extra: Partial<SubagentPart> = {}
): SubagentPart => ({
  type: "subagent",
  subagentId,
  parentSessionId: "session-1",
  name,
  status,
  progress: status === "completed" ? 100 : 60,
  startedAt: base,
  ...(status === "completed" ? { completedAt: base + 1000 * 30 } : {}),
  ...extra,
})

// parent → two children, one with its own grandchild → depth-3 tree.
const treeParts: SubagentPart[] = [
  node("root", "research-lead", "completed", { depth: 1, summary: "Mapped the call graph." }),
  node("child-a", "code-reader", "completed", {
    depth: 2,
    parentSubagentId: "root",
    startedAt: base + 1000,
    completedAt: base + 1000 * 20,
  }),
  node("child-b", "test-writer", "running", {
    depth: 2,
    parentSubagentId: "root",
    startedAt: base + 1000 * 2,
    progress: 45,
  }),
  node("grandchild", "coverage-checker", "running", {
    depth: 3,
    parentSubagentId: "child-b",
    startedAt: base + 1000 * 3,
    progress: 20,
  }),
]

const singleParts: SubagentPart[] = [
  node("solo", "doc-writer", "completed", { depth: 1, summary: "Drafted the ADR section." }),
]

const asMessage = (parts: SubagentPart[]): UIMessage["parts"] =>
  parts as unknown as UIMessage["parts"]

const meta = {
  title: "Chat/MessageParts/SubagentTree",
  component: SubagentTree,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubagentTree>

export default meta
type Story = StoryObj<typeof meta>

// Nested dispatch tree, standard mode (cards collapsed by default).
export const NestedStandard: Story = {
  args: { parts: asMessage(treeParts), mode: "standard" },
}

// Same tree in detailed mode — every node card defaults open.
export const NestedDetailed: Story = {
  args: { parts: asMessage(treeParts), mode: "detailed" },
}

// Single root run — no expand-all header (needs ≥2 nodes).
export const SingleRoot: Story = {
  args: { parts: asMessage(singleParts), mode: "standard" },
}
