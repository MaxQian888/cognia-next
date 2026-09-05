/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import {
  createIssue,
  getIssue,
  getIssueByExternalKey,
  setIssueDueDate,
  updateIssue,
} from "@/lib/db/issues"
import { listIssueEvents, __resetIssueEventClockForTesting } from "@/lib/db/issue-events"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { listLabels } from "@/lib/db/labels"
import { getDb } from "@/lib/db/schema"
import type { IssueActor, IssueProject } from "@/types/issues"
import { bindingWatermark, pushIdempotencyKey, reconcileBinding } from "./engine"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullResult,
  PushOutcome,
  RemoteIssue,
  RemotePatch,
} from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetIssueEventClockForTesting()
})
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

let container: IssueProject
beforeEach(async () => {
  container = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
})

function binding(over: Partial<IssueSyncBinding> = {}): IssueSyncBinding {
  return {
    providerId: "fake",
    projectId: "w1",
    issueProjectId: container.id,
    projectKey: "MERC",
    resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
    key: "o/r",
    ...over,
  }
}

function remote(over: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    externalId: "o/r#1",
    url: "https://x/1",
    label: "o/r#1",
    title: "Remote title",
    description: "Remote body",
    status: "todo",
    assigneeLabel: "octocat",
    labels: ["bug"],
    cycleExternalId: null,
    remoteUpdatedAt: 1_000,
    ...over,
  }
}

interface FakeOptions {
  pull?: PullResult
  push?: (patch: RemotePatch) => PushOutcome
  pushFields?: IssueSyncProvider["pushFields"]
}

function fake(options: FakeOptions = {}) {
  const pushes: Array<{ externalId: string; patch: RemotePatch; key: string }> = []
  const pulls: Array<{ since?: number; full?: boolean }> = []
  const provider: IssueSyncProvider = {
    id: "fake",
    label: "Fake",
    pullFields: ["title", "description", "status", "assignee", "labels", "dueDate", "cycle"],
    pushFields: options.pushFields ?? ["title", "description", "status", "labels", "dueDate"],
    resolveBindings: () => [],
    pull: async (_b, opts) => {
      pulls.push(opts)
      return options.pull ?? { items: [], notModified: true }
    },
    push: async (_b, ref, patch, _issue, context) => {
      pushes.push({ externalId: ref.externalId, patch, key: context.idempotencyKey })
      return options.push ? options.push(patch) : { status: "applied", remoteUpdatedAt: 5_000 }
    },
  }
  return { provider, pushes, pulls }
}

describe("reconcileBinding: import", () => {
  it("creates a local issue per unknown remote item, with labels, assignee and the ref", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 2_000 })
    expect(outcome).toMatchObject({ created: 1, updated: 0, pushed: 0, conflicts: 0 })

    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    expect(issue).toMatchObject({
      title: "Remote title",
      description: "Remote body",
      status: "todo",
      issueProjectId: container.id,
      assignee: { kind: "human", label: "octocat" },
      createdBy: { kind: "agent", id: "sync:fake" },
    })
    const labels = await listLabels("issue")
    expect(labels.some((row) => row.name === "bug")).toBe(true)
    expect(issue.labelIds).toHaveLength(1)
    expect(issue.externalRefs).toEqual([
      {
        provider: "fake",
        externalId: "o/r#1",
        url: "https://x/1",
        label: "o/r#1",
        syncedAt: 2_000,
        remoteUpdatedAt: 1_000,
        meta: { binding: "o/r" },
      },
    ])
    expect(await bindingWatermark(binding())).toBe(1_000)
  })

  it("is idempotent: a second pass with the same remote changes nothing", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 2_000 })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 3_000 })
    expect(outcome).toMatchObject({ created: 0, updated: 0, pushed: 0, conflicts: 0 })
    expect((await getDb().issues.toArray()).length).toBe(1)
  })

  it("passes the watermark to the provider and skips it on a full pass", async () => {
    const { provider, pulls } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider)
    await reconcileBinding(binding(), provider)
    await reconcileBinding(binding(), provider, { full: true })
    expect(pulls[0]).toEqual({})
    expect(pulls[1]).toEqual({ since: 1_000 })
    expect(pulls[2]).toEqual({ full: true })
  })
})

describe("reconcileBinding: field reconciliation", () => {
  async function importOne(): Promise<string> {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 2_000 })
    return (await getIssueByExternalKey("fake", "o/r#1"))!.id
  }

  it("applies a remote-only change and records synced_in", async () => {
    const id = await importOne()
    const { provider } = fake({
      pull: {
        items: [remote({ title: "Renamed remotely", remoteUpdatedAt: 3_000 })],
        notModified: false,
      },
    })
    // The ref is stamped no earlier than the newest event it examined, so a
    // fixed `now` must sit after the wall clock the events were written at.
    const T = Date.now() + 100_000
    const outcome = await reconcileBinding(binding(), provider, { now: () => T })
    expect(outcome).toMatchObject({ updated: 1, conflicts: 0, pushed: 0 })
    const issue = (await getIssue(id))!
    expect(issue.title).toBe("Renamed remotely")
    const kinds = (await listIssueEvents({ issueId: id })).map((e) => e.kind)
    expect(kinds).toContain("synced_in")
    expect(issue.externalRefs?.[0]).toMatchObject({ syncedAt: T, remoteUpdatedAt: 3_000 })
  })

  it("pushes a local-only change and advances the ref", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Renamed locally" }, HUMAN)
    await setIssueDueDate(id, 9_999, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [remote()], notModified: false } })
    const T = Date.now() + 100_000
    const outcome = await reconcileBinding(binding(), provider, { now: () => T })
    expect(outcome).toMatchObject({ pushed: 1, conflicts: 0, updated: 0 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0].patch).toEqual({ title: "Renamed locally", dueDate: 9_999 })
    expect(pushes[0].key).toBe(pushIdempotencyKey(id, pushes[0].patch))
    const issue = (await getIssue(id))!
    expect(issue.title).toBe("Renamed locally")
    expect(issue.externalRefs?.[0]).toMatchObject({ syncedAt: T, remoteUpdatedAt: 5_000 })
  })

  it("pushes local edits on rows an incremental pull did not mention", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Edited while remote was quiet" }, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [], notModified: true } })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 6_000 })
    expect(outcome.pushed).toBe(1)
    expect(pushes[0].patch).toEqual({ title: "Edited while remote was quiet" })
  })

  it("resolves a two-sided change by the newer side and records the conflict", async () => {
    const id = await importOne()
    // Local edit at ~now (well after 2_000), remote edit at 3_000: local is newer.
    await updateIssue(id, { title: "Local wins" }, HUMAN)
    const { provider, pushes } = fake({
      pull: {
        items: [remote({ title: "Remote loses", remoteUpdatedAt: 3_000 })],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider, { now: () => Date.now() + 10 })
    expect(outcome.conflicts).toBe(1)
    expect(outcome.pushed).toBe(1)
    expect((await getIssue(id))!.title).toBe("Local wins")
    expect(pushes[0].patch).toEqual({ title: "Local wins" })
    const conflict = (await listIssueEvents({ issueId: id })).find(
      (e) => e.kind === "sync_conflict"
    )!
    expect(conflict.payload).toMatchObject({
      kind: "sync_conflict",
      provider: "fake",
      field: "title",
      winner: "local",
      localValue: "Local wins",
      remoteValue: "Remote loses",
    })
  })

  it("lets a newer remote win a two-sided change", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Local loses" }, HUMAN)
    const { provider, pushes } = fake({
      pull: {
        items: [remote({ title: "Remote wins", remoteUpdatedAt: Date.now() + 60_000 })],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome.conflicts).toBe(1)
    expect(pushes).toHaveLength(0)
    expect((await getIssue(id))!.title).toBe("Remote wins")
  })

  it("leaves the ref alone when a push is queued behind approval", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Pending" }, HUMAN)
    const { provider } = fake({
      pull: { items: [remote()], notModified: false },
      push: () => ({ status: "queued", jobId: "job-1" }),
    })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 7_000 })
    expect(outcome).toMatchObject({ queued: 1, pushed: 0 })
    expect((await getIssue(id))!.externalRefs?.[0].syncedAt).toBe(2_000)
  })

  it("never pushes a field the provider does not accept", async () => {
    const id = await importOne()
    await updateIssue(id, { priority: "urgent" }, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider)
    expect(pushes).toHaveLength(0)
  })

  it("does not import into another workspace's container and ignores foreign locals", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "foreign",
      createdBy: HUMAN,
      externalRefs: [{ provider: "fake", externalId: "o/r#1" }],
    })
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome).toMatchObject({ created: 0, updated: 0 })
  })
})

describe("reconcileBinding: cycles and links", () => {
  it("upserts remote cycles and plans imported issues into them", async () => {
    const { provider } = fake({
      pull: {
        items: [remote({ cycleExternalId: "milestone/3" })],
        cycles: [{ externalId: "milestone/3", kind: "milestone", name: "v1.0", status: "active" }],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), provider)
    const cycles = await listIssueCycles({ projectId: "w1" })
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({
      name: "v1.0",
      kind: "milestone",
      issueProjectId: container.id,
    })
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.cycleId).toBe(cycles[0].id)

    const renamed = fake({
      pull: {
        items: [],
        cycles: [
          { externalId: "milestone/3", kind: "milestone", name: "v1.1", status: "completed" },
        ],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), renamed.provider)
    const after = await listIssueCycles({ projectId: "w1" })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: "v1.1", status: "completed" })
  })

  it("attaches link refs to the issues a pull request names, by identifier or remote id", async () => {
    const local = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Local only",
      createdBy: HUMAN,
    })
    const { provider } = fake({
      pull: {
        items: [remote()],
        links: [
          {
            provider: "github-pr",
            externalId: "o/r#7",
            url: "https://x/pull/7",
            label: "PR #7",
            mentionsIdentifiers: [local.identifier],
            mentionsExternalIds: ["o/r#1"],
          },
        ],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome.linked).toBe(2)
    expect((await getIssue(local.id))!.externalKeys).toContain("github-pr:o/r#7")
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.externalKeys).toContain(
      "github-pr:o/r#7"
    )
    // Linking again is a no-op.
    expect((await reconcileBinding(binding(), provider)).linked).toBe(0)
  })
})
