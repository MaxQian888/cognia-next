import type { UIMessage } from "ai"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { GitFileChange, GitStatus } from "@/types/git"
import {
  changedPathCount,
  conversationRepoPaths,
  editedPathsFromMessages,
  scopeStatus,
} from "./conversation-scope"

function tool(type: string, input: unknown, state = "output-available") {
  return { type, toolCallId: type, state, input }
}

function assistant(...parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage
}

describe("editedPathsFromMessages", () => {
  it("collects the paths completed file-editing calls wrote", () => {
    const patch = ["--- a/p.ts", "+++ b/q.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")
    const paths = editedPathsFromMessages([
      assistant(
        tool("tool-Write", { file_path: "/repo/a.ts" }),
        tool("tool-mcp__cognia-tools__edit", { path: "b.ts" }),
        tool("tool-MultiEdit", { file_path: "c.ts", edits: [{ file_path: "d.ts" }] }),
        tool("tool-NotebookEdit", { notebook_path: "n.ipynb" }),
        tool("tool-apply_patch", { patch }),
        {
          type: "dynamic-tool",
          toolName: "Write",
          state: "output-available",
          input: { file_path: "e.ts" },
        }
      ),
    ])
    expect(paths).toEqual(["/repo/a.ts", "b.ts", "c.ts", "d.ts", "n.ipynb", "p.ts", "q.ts", "e.ts"])
  })

  it("skips reads, failed or pending calls, and the user's own messages", () => {
    expect(
      editedPathsFromMessages([
        assistant(
          tool("tool-Read", { file_path: "r.ts" }),
          tool("tool-Write", { file_path: "denied.ts" }, "output-denied"),
          tool("tool-Edit", { file_path: "failed.ts" }, "output-error"),
          tool("tool-Edit", { file_path: "running.ts" }, "input-available"),
          { type: "text", text: "hi" }
        ),
        {
          id: "u",
          role: "user",
          parts: [tool("tool-Write", { file_path: "u.ts" })],
        } as unknown as UIMessage,
      ])
    ).toEqual([])
  })
})

function turn(workspaceRoot: string, paths: string[]): CodeAdoptionTurnRow {
  return {
    id: `s:${paths.join()}`,
    runId: 1,
    sessionId: "s",
    workspaceRoot,
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: paths.length,
    totalAdded: 0,
    totalRemoved: 0,
    files: paths.map((path) => ({ path, added: 1, removed: 0, isNew: false, hunks: [] })),
    truncated: false,
  }
}

describe("conversationRepoPaths", () => {
  it("maps tool paths into the repository and adds the recorded turns", () => {
    const paths = conversationRepoPaths({
      rootPath: "/repo",
      toolPaths: ["/repo/src/a.ts", "rel/b.ts", "/elsewhere/c.ts", "../escape.ts"],
      turns: [
        turn("/repo", ["shell/written.ts"]),
        turn("/repo/pkg", ["pkg/x.ts"]),
        turn("/other", ["no.ts"]),
      ],
    })
    expect([...paths].sort()).toEqual(["pkg/x.ts", "rel/b.ts", "shell/written.ts", "src/a.ts"])
  })
})

function change(path: string, group: GitFileChange["group"], origPath: string | null = null) {
  return { path, origPath, status: "modified" as const, staged: group === "staged", group }
}

describe("scopeStatus", () => {
  const status: GitStatus = {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [change("a.ts", "staged"), change("new.ts", "staged", "old.ts")],
    changes: [change("a.ts", "changes"), change("mine.ts", "changes")],
    merge: [change("m.ts", "merge")],
    isRebasing: false,
    isMerging: false,
  }

  it("keeps the changes whose path or rename source the conversation touched", () => {
    const scoped = scopeStatus(status, new Set(["a.ts", "old.ts"]))
    expect(scoped.staged.map((c) => c.path)).toEqual(["a.ts", "new.ts"])
    expect(scoped.changes.map((c) => c.path)).toEqual(["a.ts"])
    expect(scoped.merge).toEqual([])
    expect(scoped.branch).toBe("main")
  })

  it("counts distinct paths across groups", () => {
    expect(changedPathCount(status)).toBe(4)
    expect(changedPathCount(null)).toBe(0)
  })
})
