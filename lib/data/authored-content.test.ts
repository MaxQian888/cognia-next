import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { allocateIssueNumber } from "@/lib/db/issue-counters"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { createWorkflowVersion } from "@/lib/workflow/versioning/version-snapshot"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { buildBackupPackage } from "./build-package"
import { buildBackupStream } from "./build-stream"
import { readStreamPackage } from "./read-stream-package"
import { applyBackupPackage } from "./apply-package"
import { AUTHORED_CONTENT_TABLES, exportAuthoredContent } from "./authored-content"
import type { BackupPackageV3, ExportOptions } from "./types"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const options: ExportOptions = {
  includeSessions: true,
  includeApiKey: false,
  includeLocalStorage: false,
}
const date = new Date("2026-10-21T00:00:00.000Z")

async function seedGraph() {
  const db = getDb()
  const workflow = {
    id: "w",
    schemaVersion: 1,
    name: "Draft",
    nodes: [],
    edges: [],
    settings: {},
    folderId: "wf",
    knowledgeBaseIds: ["kb"],
    createdAt: 1,
    updatedAt: 1,
    published: { versionId: "version", environment: "production" },
  }
  const rows: Record<string, Record<string, unknown>[]> = {
    projects: [
      {
        id: "p",
        name: "Workspace",
        roots: [],
        knowledgeBase: [],
        sessionIds: ["s"],
        sessionCount: 1,
        messageCount: 0,
        createdAt: date,
        updatedAt: date,
        lastAccessedAt: date,
        workspaceProvisioning: { status: "approved" },
        defaultEnvironmentId: "this-machine",
        terminalConfig: { env: { AWS_KEY: "must-not-travel" } },
      },
    ],
    sessionFolders: [
      { id: "f", projectId: "p", name: "Research", order: 0, createdAt: 1, updatedAt: 1 },
    ],
    workflowFolders: [
      { id: "wf", name: "Automations", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
    ],
    knowledgeBases: [{ id: "kb", name: "Sources", createdAt: 1, updatedAt: 1 }],
    knowledgeBaseSources: [
      {
        id: "source",
        knowledgeBaseId: "kb",
        kind: "text",
        format: "text",
        title: "Original",
        content: "Keep original source",
        status: "ready",
        chunkCount: 12,
        generationSnapshots: { old: { vectorIds: ["v"] } },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    knowledgeNotes: [{ id: "note", title: "Curated", body: "Keep note", tags: [] }],
    labels: [{ id: "label", name: "Research", createdAt: 1, updatedAt: 1 }],
    issueProjects: [
      { id: "ip", projectId: "p", key: "BAK", name: "Backups", createdAt: 1, updatedAt: 1 },
    ],
    issueCycles: [
      {
        id: "cycle",
        projectId: "p",
        issueProjectId: "ip",
        name: "Cycle",
        kind: "cycle",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    issues: [
      {
        id: "issue",
        projectId: "p",
        issueProjectId: "ip",
        identifier: "BAK-7",
        number: 7,
        title: "Preserve",
        cycleId: "cycle",
        labelIds: ["label"],
        blockedBy: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    issueEvents: [{ id: "event", issueId: "issue", kind: "created", ts: 1, payload: {} }],
    agentTeams: [
      {
        id: "squad",
        projectId: "p",
        name: "Research team",
        task: "Research",
        status: "executing",
        config: {},
        leadId: "mate",
        teammateIds: ["mate"],
        taskIds: ["task"],
        messageIds: ["runtime-message"],
        sessionId: "s",
        externalPickup: { state: "approved" },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    agentTeammates: [
      {
        id: "mate",
        teamId: "squad",
        name: "Researcher",
        role: "general-assistant",
        config: {},
        status: "executing",
        currentTaskId: "task",
        completedTaskIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    agentTeamTasks: [
      {
        id: "task",
        teamId: "squad",
        title: "Read",
        status: "claimed",
        assignedTo: "mate",
        claimedBy: "mate",
        dependencies: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    workflows: [workflow],
    workflowVersions: [
      {
        ...createWorkflowVersion({
          workflow: workflow as unknown as VisualWorkflow,
          workflowInterface: { inputSchema: { type: "object" } },
          accountId: "original-account",
          sequence: 1,
          createdAt: 1,
        }),
        id: "version",
      },
    ],
    sessions: [
      {
        id: "s",
        title: "Research",
        kind: "direct",
        projectId: "p",
        folderId: "f",
        squadId: "squad",
        issueId: "issue",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    issueCounters: [{ scopeId: "ip", next: 30 }],
  }
  for (const [table, values] of Object.entries(rows)) await db.table(table).bulkPut(values)
}

async function exportGraph(format: string): Promise<BackupPackageV3> {
  return format === "v3"
    ? buildBackupPackage(options, { storage: null })
    : (await readStreamPackage(buildBackupStream(options, { storage: null }))).pkg
}

it.each(["v3", "v4"])(
  "restores authored graphs and original source content from %s",
  async (format) => {
    await seedGraph()
    const pkg = await exportGraph(format)
    for (const name of AUTHORED_CONTENT_TABLES) expect(pkg.payload[name]).toHaveLength(1)
    expect(pkg.payload.projects?.[0].createdAt).toBe(date.toISOString())
    await fixture.restore()
    await applyBackupPackage(pkg, {
      mergeStrategy: "skip",
      includeSessions: true,
      includeApiKey: false,
    })
    const db = getDb()
    const project = await db.projects.get("p")
    expect(project?.createdAt).toEqual(date)
    expect(project?.workspaceProvisioning).toBeUndefined()
    expect(project?.defaultEnvironmentId).toBeUndefined()
    expect(project?.terminalConfig?.env).toBeUndefined()
    expect(await db.sessions.get("s")).toMatchObject({
      projectId: "p",
      folderId: "f",
      squadId: "squad",
      issueId: "issue",
    })
    expect(await db.knowledgeBaseSources.get("source")).toMatchObject({
      content: "Keep original source",
      status: "pending",
      chunkCount: 0,
    })
    expect(await db.knowledgeBaseChunks.count()).toBe(0)
    expect(await db.agentTeams.get("squad")).toMatchObject({ status: "paused", messageIds: [] })
    expect(await db.agentTeamTasks.get("task")).toMatchObject({ status: "pending" })
    expect((await db.agentTeamTasks.get("task"))?.claimedBy).toBeUndefined()
    expect((await db.workflows.get("w"))?.published).toBeUndefined()
    expect(await db.workflowVersions.get("version")).toMatchObject({
      accountId: getActiveAccountId(),
    })
    expect((await db.workflowVersions.get("version"))?.configDefinition.secretRefs).toEqual([])
    expect((await db.workflowVersions.get("version"))?.dependencyManifest.credentials).toEqual([])
    expect(await allocateIssueNumber("ip")).toBe(30)
  }
)

it.each(["v3", "v4"])(
  "duplicate restore remaps parents, siblings and preexisting session references in %s",
  async (format) => {
    await seedGraph()
    const pkg = await exportGraph(format)
    const untouched = JSON.stringify(pkg)
    await applyBackupPackage(pkg, {
      mergeStrategy: "duplicate",
      includeSessions: true,
      includeApiKey: false,
    })
    const db = getDb()
    const session = (await db.sessions.toArray()).find((row) => row.id !== "s")!
    expect(session.id).not.toBe("s")
    expect(session.projectId).not.toBe("p")
    const project = await db.projects.get(session.projectId!)
    expect(project?.sessionIds).toEqual([session.id])
    expect((await db.sessionFolders.get(session.folderId!))?.projectId).toBe(project?.id)
    const team = await db.agentTeams.get(session.squadId!)
    expect(team?.sessionId).toBe(session.id)
    expect((await db.agentTeammates.get(team!.leadId))?.teamId).toBe(team!.id)
    const task = await db.agentTeamTasks.get(team!.taskIds[0])
    expect(task?.assignedTo).toBe(team!.leadId)
    expect(task?.teamId).toBe(team!.id)
    const issue = await db.issues.get(session.issueId!)
    const issueProject = await db.issueProjects.get(issue!.issueProjectId)
    expect(issueProject?.key).not.toBe("BAK")
    expect(issue!.identifier).toBe(`${issueProject!.key}-7`)
    expect((await db.issueCycles.get(issue!.cycleId!))?.issueProjectId).toBe(issueProject!.id)
    expect(await allocateIssueNumber(issueProject!.id)).toBe(30)
    const version = (await db.workflowVersions.toArray()).find((row) => row.id !== "version")!
    expect(version.definition.id).toBe(version.workflowId)
    expect((await db.workflows.get(version.workflowId))?.folderId).not.toBe("wf")
    expect(version.definition.knowledgeBaseIds?.[0]).not.toBe("kb")
    expect(JSON.stringify(pkg)).toBe(untouched)
  }
)

it("skip and overwrite preserve merge semantics and never lower issue watermarks", async () => {
  await seedGraph()
  const pkg = await exportGraph("v3")
  await getDb().projects.update("p", { name: "Keep local" })
  await getDb().issueCounters.put({ scopeId: "ip", next: 90 })
  await applyBackupPackage(pkg, {
    mergeStrategy: "skip",
    includeSessions: true,
    includeApiKey: false,
  })
  expect((await getDb().projects.get("p"))?.name).toBe("Keep local")
  await applyBackupPackage(pkg, {
    mergeStrategy: "overwrite",
    includeSessions: true,
    includeApiKey: false,
  })
  expect((await getDb().projects.get("p"))?.name).toBe("Workspace")
  expect(await allocateIssueNumber("ip")).toBe(90)
})

it("invalid authored children abort the entire existing restore transaction", async () => {
  await seedGraph()
  const pkg = await exportGraph("v3")
  pkg.payload.knowledgeBaseSources![0].knowledgeBaseId = "missing-parent"
  await fixture.restore()
  await expect(
    applyBackupPackage(pkg, {
      mergeStrategy: "overwrite",
      includeSessions: true,
      includeApiKey: false,
    })
  ).rejects.toThrow("Missing knowledgeBases parent")
  expect(await getDb().projects.count()).toBe(0)
  expect(await getDb().sessions.count()).toBe(0)
})

it.each(["v3", "v4"])(
  "removes inline HTTP credentials from %s when secrets are excluded",
  async (format) => {
    await seedGraph()
    await getDb()
      .table("workflows")
      .update("w", {
        nodes: [
          {
            id: "http",
            type: "io.http",
            data: {
              params: {
                headers: {
                  Authorization: "Bearer private-inline",
                  Cookie: "session=private-cookie",
                  Accept: "text/plain",
                },
                headersJson: JSON.stringify({
                  Authorization: "Bearer private-json",
                  Accept: "text/plain",
                }),
              },
            },
          },
        ],
      })
    const pkg = await exportGraph(format)
    expect(JSON.stringify(pkg.payload.workflows)).not.toContain("private-")
    expect(JSON.stringify(pkg.payload.workflows)).toContain("text/plain")
  }
)

it("overwrite cannot change an immutable version already referenced by a local deployment", async () => {
  await seedGraph()
  const original = await getDb().workflowVersions.get("version")
  const pkg = await exportGraph("v3")
  ;(pkg.payload.workflowVersions![0].definition as Record<string, unknown>).name =
    "Different executable graph"
  await getDb()
    .table("workflowDeployments")
    .put({ id: "active", versionId: "version", workflowId: "w", status: "active" })
  await applyBackupPackage(pkg, {
    mergeStrategy: "overwrite",
    includeSessions: false,
    includeApiKey: false,
  })
  expect(await getDb().workflowVersions.get("version")).toEqual(original)
  const restored = (await getDb().workflowVersions.toArray()).find((row) => row.id !== "version")
  expect(restored?.definition.name).toBe("Different executable graph")
})

it("duplicate remaps typed issue actors to the duplicated team", async () => {
  await seedGraph()
  await getDb().issues.update("issue", {
    assignee: { kind: "team", id: "squad" },
    assigneeKind: "team",
    assigneeId: "squad",
  })
  await getDb().issueProjects.update("ip", { lead: { kind: "team", id: "squad" } })
  const pkg = await exportGraph("v3")
  await applyBackupPackage(pkg, {
    mergeStrategy: "duplicate",
    includeSessions: true,
    includeApiKey: false,
  })
  const duplicate = (await getDb().issues.toArray()).find((row) => row.id !== "issue")!
  expect(duplicate.assignee?.id).not.toBe("squad")
  expect(duplicate.assigneeId).toBe(duplicate.assignee?.id)
  expect((await getDb().issueProjects.get(duplicate.issueProjectId))?.lead?.id).toBe(
    duplicate.assigneeId
  )
})

it("sessions-only export carries folder ancestors for workspace-less paired sessions", async () => {
  await seedGraph()
  await getDb().sessions.update("s", { projectId: undefined })
  const pkg = await buildBackupPackage({ ...options, includeCoreData: false }, { storage: null })
  expect(pkg.payload.projects).toEqual([expect.objectContaining({ id: "p" })])
  expect(pkg.payload.sessionFolders).toEqual([expect.objectContaining({ id: "f", projectId: "p" })])
})

it("v3 accumulates every authored page instead of replacing earlier pages", async () => {
  await seedGraph()
  const project = await getDb().projects.get("p")
  await getDb().projects.bulkPut(
    Array.from({ length: 500 }, (_, i) => ({ ...project!, id: `p-${i}` }))
  )
  const source = await getDb().knowledgeBaseSources.get("source")
  await getDb().knowledgeBaseSources.bulkPut(
    Array.from({ length: 500 }, (_, i) => ({ ...source!, id: `source-${i}` }))
  )
  const pkg = await exportGraph("v3")
  expect(pkg.payload.projects).toHaveLength(501)
  expect(pkg.payload.knowledgeBaseSources).toHaveLength(501)
  await fixture.restore()
  await applyBackupPackage(pkg, {
    mergeStrategy: "skip",
    includeSessions: true,
    includeApiKey: false,
  })
  expect(await getDb().knowledgeBaseSources.count()).toBe(501)
  expect((await getDb().sessionFolders.get("f"))?.projectId).toBe("p")
})

it("sessions-only selection carries only referenced workspace/folder parents", async () => {
  await seedGraph()
  await getDb()
    .table("projects")
    .put({ ...(await getDb().projects.get("p")), id: "unrelated" })
  const sections = []
  for await (const section of exportAuthoredContent(getDb(), {
    ...options,
    includeCoreData: false,
  }))
    sections.push(section)
  expect(sections).toEqual([
    { section: "projects", rows: [expect.objectContaining({ id: "p" })] },
    { section: "sessionFolders", rows: [expect.objectContaining({ id: "f" })] },
  ])
})
