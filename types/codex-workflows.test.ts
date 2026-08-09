import type { CdpAuditEvent, CdpGrant } from "./browser-developer"
import type { SessionExecutionContext } from "./execution-context"
import type { ProjectEnvironment } from "./project-environment"
import type { ReviewFeedbackBundle } from "./review"

describe("Codex-inspired workflow contracts", () => {
  it("keeps environment secrets as opaque keyring references", () => {
    const environment = {
      id: "env-1",
      projectId: "project-1",
      name: "Development",
      isEnabled: true,
      setupScript: { default: "pnpm install" },
      actions: [],
      variables: { NODE_ENV: "development" },
      keyringReferences: [{ variable: "API_TOKEN", keyringRef: "credential-1" }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies ProjectEnvironment

    expect(environment.keyringReferences).toEqual([
      { variable: "API_TOKEN", keyringRef: "credential-1" },
    ])
    expect(JSON.stringify(environment)).not.toContain("secret-value")
  })

  it("binds a managed worktree to one durable task workspace", () => {
    const context = {
      location: "managedWorktree",
      projectId: "project-1",
      projectRoot: "/repo",
      worktreePath: "/managed/session-1",
      taskWorkspace: { taskId: "task-1", workspaceKey: "session-1", runId: "run-1" },
      baseRef: "main",
      lifecycle: { state: "ready", createdAt: 1, updatedAt: 2, pinned: false },
    } satisfies SessionExecutionContext

    expect(context.taskWorkspace.workspaceKey).toBe("session-1")
  })

  it("represents an editable multi-root feedback draft", () => {
    const bundle = {
      id: "bundle-1",
      sessionId: "session-1",
      scope: "lastTurn",
      repositoryRoots: ["/repo-a", "/repo-b"],
      comments: [],
      summary: "Keep the change focused.",
      state: "draft",
      createdAt: 1,
      updatedAt: 2,
    } satisfies ReviewFeedbackBundle

    expect(bundle.repositoryRoots).toHaveLength(2)
    expect(bundle.state).toBe("draft")
  })

  it("keeps CDP authority session-scoped and audits metadata only", () => {
    const grant = {
      id: "grant-1",
      sessionId: "session-1",
      browserSessionId: "browser-1",
      origin: "http://localhost:3000",
      capabilities: ["dom"],
      grantedAt: 1,
      expiresAt: 2,
    } satisfies CdpGrant
    const audit = {
      id: "audit-1",
      grantId: grant.id,
      sessionId: grant.sessionId,
      browserSessionId: grant.browserSessionId,
      origin: grant.origin,
      capability: "dom",
      method: "DOM.getDocument",
      outcome: "used",
      createdAt: 1,
    } satisfies CdpAuditEvent

    expect(audit).not.toHaveProperty("requestBody")
    expect(audit.sessionId).toBe(grant.sessionId)
  })
})
