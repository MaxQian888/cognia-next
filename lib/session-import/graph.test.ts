import type { ImportedConversation } from "@/lib/data/importers/types"

import { buildImportedSessionGraph } from "./graph"

function conversation(
  id: string,
  options: { parentSessionId?: string; kind?: "direct" | "subagent" } = {}
): ImportedConversation {
  return {
    session: {
      id,
      title: id,
      kind: options.kind ?? "direct",
      parentSessionId: options.parentSessionId,
      createdAt: 1000,
      updatedAt: 2000,
    } as never,
    messages: [
      {
        id: `${id}:m0`,
        sessionId: id,
        role: "user",
        parts: [{ type: "text", text: id }],
        createdAt: 1000,
      } as never,
    ],
  }
}

describe("buildImportedSessionGraph", () => {
  it("converts nested conversations into canonical lineage without reporting them dropped", () => {
    const root = conversation("import:claude-code:root")
    const child = conversation("import:claude-code:child", {
      parentSessionId: root.session.id,
      kind: "subagent",
    })
    const grandchild = conversation("import:claude-code:grandchild", {
      parentSessionId: child.session.id,
      kind: "subagent",
    })
    child.nested = [grandchild]
    root.nested = [child]

    const graph = buildImportedSessionGraph(root, {
      sourceRuntime: "claude-code",
      sourceVersion: "2.1.251",
      importFidelity: "structured",
      verifiedAt: "2026-08-29",
    })

    expect(graph.nodes).toHaveLength(3)
    expect(graph.sourceVersion).toBe("2.1.251")
    expect(graph.sourceRevision).toMatch(/^graph1-/)
    expect(graph.nodes[1].session.header.lineage).toMatchObject({
      kind: "subagent",
      parentCanonicalSessionId: graph.nodes[0].session.header.canonicalSessionId,
    })
    expect(graph.nodes[2].session.header.lineage).toMatchObject({
      kind: "subagent",
      parentCanonicalSessionId: graph.nodes[1].session.header.canonicalSessionId,
    })
    expect(graph.nodes.flatMap((node) => node.loss.losses)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "nested" })])
    )
    expect(graph.nodes[0].session.header.source).toEqual({
      version: "2.1.251",
      revision: graph.sourceRevision,
      verifiedAt: "2026-08-29",
    })
  })

  it("produces a stable revision that changes with lifecycle state", () => {
    const first = conversation("import:codex:root")
    first.session.importLifecycle = { status: "running", background: true }
    const second = structuredClone(first)
    second.session.importLifecycle = { status: "completed", background: true }

    const a = buildImportedSessionGraph(first, {
      sourceRuntime: "codex",
      importFidelity: "structured",
    })
    const b = buildImportedSessionGraph(second, {
      sourceRuntime: "codex",
      importFidelity: "structured",
    })
    expect(a.sourceRevision).not.toBe(b.sourceRevision)
  })
})
