import { resolveWorkspaceRowHref, type WorkspaceRowTargetDeps } from "./workspace-row-target"

const deps = (over: Partial<WorkspaceRowTargetDeps> = {}): WorkspaceRowTargetDeps => ({
  getPlan: async (id) => (id === "plan-1" ? { sessionId: "session-9" } : undefined),
  getIssueRun: async (id) => (id === "run-1" ? { issueId: "issue-4" } : undefined),
  ...over,
})

it("opens an issue row on the board", async () => {
  await expect(resolveWorkspaceRowHref("issue:abc", deps())).resolves.toBe("/issues?id=abc")
})

it("opens a plan row in the chat session that owns the plan", async () => {
  await expect(resolveWorkspaceRowHref("plan:plan-1", deps())).resolves.toBe("/?session=session-9")
})

it("opens a run row on the issue the run is working", async () => {
  await expect(resolveWorkspaceRowHref("run:run-1", deps())).resolves.toBe("/issues?id=issue-4")
})

it("returns null for a record that no longer exists or an unknown row", async () => {
  await expect(resolveWorkspaceRowHref("plan:gone", deps())).resolves.toBeNull()
  await expect(resolveWorkspaceRowHref("run:gone", deps())).resolves.toBeNull()
  await expect(resolveWorkspaceRowHref("cycle:1", deps())).resolves.toBeNull()
  await expect(resolveWorkspaceRowHref("issue:", deps())).resolves.toBeNull()
  await expect(resolveWorkspaceRowHref("noprefix", deps())).resolves.toBeNull()
})

it("keeps ids containing colons intact", async () => {
  await expect(resolveWorkspaceRowHref("issue:ext:42", deps())).resolves.toBe("/issues?id=ext%3A42")
})
