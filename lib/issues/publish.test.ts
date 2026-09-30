jest.mock("@/lib/db/issues", () => ({
  getIssue: jest.fn(),
  linkIssueExternal: jest.fn(),
  linkIssueToGithub: jest.fn(),
  githubExternalRef: (ref: { repoFullName: string; number: number; htmlUrl: string }) => ({
    provider: "github",
    externalId: `${ref.repoFullName}#${ref.number}`,
    url: ref.htmlUrl,
    label: `${ref.repoFullName}#${ref.number}`,
  }),
}))
jest.mock("./github-writeback", () => ({ createGithubIssue: jest.fn() }))
jest.mock("./sync/providers/github", () => ({ GITHUB_SYNC_PROVIDER_ID: "github" }))

import type { Issue, IssueProject } from "@/types/issues"
import { IssueSyncRegistry } from "./sync/registry"
import type { IssueSyncBinding, IssueSyncProvider } from "./sync/types"
import { listPublishTargets, publishIssue, type PublishIssueDeps } from "./publish"

function container(resources: IssueProject["resources"]): IssueProject {
  return {
    id: "c1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "backlog",
    priority: "none",
    resources,
    createdAt: 1,
    updatedAt: 1,
  }
}

const tasklist = {
  kind: "lark-tasklist" as const,
  adapterId: "cai_1",
  tasklistGuid: "tl-1",
  name: "Sprint board",
  addedAt: 1,
}

function registry(options: { larkCreate?: IssueSyncProvider["create"] } = {}) {
  const r = new IssueSyncRegistry()
  const bindingsFor =
    (providerId: string, kind: string, keyOf: (resource: never) => string) =>
    (containers: readonly IssueProject[]): IssueSyncBinding[] =>
      containers.flatMap((c) =>
        c.resources
          .filter(
            (resource) =>
              resource.kind === kind &&
              (kind !== "github-repo" ||
                (resource as { sync?: { mode?: string } }).sync?.mode === "import")
          )
          .map((resource) => ({
            providerId,
            projectId: c.projectId,
            issueProjectId: c.id,
            projectKey: c.key,
            resource,
            key: keyOf(resource as never),
          }))
      )
  r.register({
    id: "github",
    label: "GitHub",
    pullFields: [],
    pushFields: [],
    resolveBindings: bindingsFor(
      "github",
      "github-repo",
      (resource: { repoFullName: string }) => resource.repoFullName
    ),
    pull: async () => ({ items: [], notModified: true }),
  })
  r.register({
    id: "lark-task",
    label: "Lark tasks",
    pullFields: [],
    pushFields: [],
    resolveBindings: bindingsFor(
      "lark-task",
      "lark-tasklist",
      (resource: { tasklistGuid: string }) => resource.tasklistGuid
    ),
    pull: async () => ({ items: [], notModified: true }),
    ...(options.larkCreate ? { create: options.larkCreate } : {}),
  })
  return r
}

const issue = {
  id: "i1",
  title: "Crash on save",
  description: "Steps to reproduce",
  externalRefs: [],
} as unknown as Issue

describe("listPublishTargets", () => {
  it("offers every bound GitHub repo and every binding whose provider can create", () => {
    const targets = listPublishTargets(
      issue,
      container([
        { kind: "github-repo", repoFullName: "acme/app", addedAt: 1 },
        {
          kind: "github-repo",
          repoFullName: "acme/api",
          addedAt: 1,
          sync: { mode: "import" },
        },
        tasklist,
      ]),
      registry({ larkCreate: jest.fn() })
    )
    expect(targets.map((target) => target.id)).toEqual([
      "github:acme/app",
      "github:acme/api",
      "lark-task:tl-1",
    ])
    expect(targets[0]).not.toHaveProperty("binding")
    expect(targets[1]).toHaveProperty("binding.key", "acme/api")
    expect(targets[2]).toMatchObject({ providerLabel: "Lark tasks", resourceName: "Sprint board" })
  })

  it("leaves out providers that cannot create and targets already linked", () => {
    const linked = {
      ...issue,
      githubRef: { repoFullName: "acme/app", number: 3, htmlUrl: "u" },
      externalRefs: [{ provider: "lark-task", externalId: "t1", meta: { binding: "tl-1" } }],
    } as unknown as Issue
    const resources: IssueProject["resources"] = [
      { kind: "github-repo", repoFullName: "acme/app", addedAt: 1 },
      tasklist,
    ]
    expect(
      listPublishTargets(linked, container(resources), registry({ larkCreate: jest.fn() }))
    ).toEqual([])
    expect(listPublishTargets(issue, container([tasklist]), registry())).toEqual([])
    expect(listPublishTargets(issue, undefined, registry())).toEqual([])
  })
})

describe("publishIssue", () => {
  function deps(over: Partial<PublishIssueDeps> = {}): PublishIssueDeps {
    return {
      getIssue: jest.fn(async () => issue) as never,
      linkIssueToGithub: jest.fn(async () => undefined),
      linkIssueExternal: jest.fn(async () => undefined),
      createGithubIssue: jest.fn(async () => ({
        repoFullName: "acme/api",
        number: 42,
        htmlUrl: "https://github.com/acme/api/issues/42",
        updatedAt: 7_000,
      })),
      registry: registry(),
      now: () => 9_000,
      ...over,
    }
  }

  it("creates the GitHub issue from the local title and body and links it", async () => {
    const d = deps()
    const ref = await publishIssue(
      "i1",
      { kind: "github", id: "github:acme/api", repoFullName: "acme/api" },
      { kind: "human" },
      d
    )
    expect(d.createGithubIssue).toHaveBeenCalledWith({
      repoFullName: "acme/api",
      title: "Crash on save",
      body: "Steps to reproduce",
      idempotencyKey: "issue-publish:i1:acme/api",
    })
    expect(d.linkIssueToGithub).toHaveBeenCalledWith(
      "i1",
      { repoFullName: "acme/api", number: 42, htmlUrl: "https://github.com/acme/api/issues/42" },
      { kind: "human" }
    )
    expect(d.linkIssueExternal).not.toHaveBeenCalled()
    expect(ref).toMatchObject({ provider: "github", externalId: "acme/api#42" })
  })

  it("marks an import-mode link as in step, so the next sync does not push it back", async () => {
    const d = deps()
    const binding = { key: "acme/api" } as IssueSyncBinding
    await publishIssue(
      "i1",
      { kind: "github", id: "github:acme/api", repoFullName: "acme/api", binding },
      { kind: "human" },
      d
    )
    expect(d.linkIssueExternal).toHaveBeenCalledWith(
      "i1",
      expect.objectContaining({
        externalId: "acme/api#42",
        syncedAt: 9_000,
        remoteUpdatedAt: 7_000,
        meta: { binding: "acme/api" },
      }),
      { kind: "human" }
    )
  })

  it("creates through the provider for any other binding and links the result", async () => {
    const create = jest.fn(async () => ({
      provider: "lark-task",
      externalId: "t9",
      label: "Crash",
    }))
    const d = deps({ registry: registry({ larkCreate: create }) })
    const binding = { key: "tl-1", providerId: "lark-task" } as IssueSyncBinding
    const ref = await publishIssue(
      "i1",
      {
        kind: "binding",
        id: "lark-task:tl-1",
        providerId: "lark-task",
        providerLabel: "Lark tasks",
        resourceName: "Sprint board",
        binding,
      },
      { kind: "human" },
      d
    )
    expect(create).toHaveBeenCalledWith(binding, issue)
    expect(ref).toEqual({
      provider: "lark-task",
      externalId: "t9",
      label: "Crash",
      meta: { binding: "tl-1" },
    })
    expect(d.linkIssueExternal).toHaveBeenCalledWith("i1", ref, { kind: "human" })
  })

  it("refuses a provider that cannot create, and a missing issue", async () => {
    const target = {
      kind: "binding" as const,
      id: "lark-task:tl-1",
      providerId: "lark-task",
      providerLabel: "Lark tasks",
      resourceName: "Sprint board",
      binding: { key: "tl-1" } as IssueSyncBinding,
    }
    await expect(publishIssue("i1", target, { kind: "human" }, deps())).rejects.toThrow(
      "cannot create"
    )
    await expect(
      publishIssue(
        "i1",
        target,
        { kind: "human" },
        deps({ getIssue: jest.fn(async () => undefined) as never })
      )
    ).rejects.toThrow("not found")
  })
})
