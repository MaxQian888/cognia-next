/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS audit probe run directly by node, not app code */
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const root = process.argv[2] || process.cwd()
const ts = require(path.join(root, "node_modules/typescript"))
const assert = require("node:assert/strict")
function load(relative, mocks) {
  const filename = path.join(root, relative)
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod.require = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    throw new Error("Unexpected import: " + id)
  }
  mod._compile(code, filename)
  return mod.exports
}
const mirror = { githubMirrorId: (repo, number) => `${repo}#${number}` }
const fetchModule = load("lib/github/issues.ts", { "@/lib/db/github-issue-mirror": mirror })
const syncModule = load("lib/issues/github-sync.ts", {
  "@/lib/github/issues": fetchModule,
  "@/lib/db/github-issue-mirror": mirror,
})
const providerModule = load("lib/issues/sync/providers/github.ts", {
  "@/lib/github/issues": fetchModule,
  "@/lib/issues/sources/github-source": {
    githubStateToStatus: (state) => (state === "closed" ? "done" : "todo"),
  },
  "@/lib/issues/github-writeback": {},
  "@/lib/issues/sync-runner": { MissingGithubCredentialError: Error },
  "@/lib/integrations/action-runner": {},
  "@/lib/ai/agent/team/pr-feedback/resolvers": {},
  "@/types/issues": { statusCategoryOf: (state) => state },
  "../bindings": {
    isGithubImportBinding: (r) => r.kind === "github-repo" && r.sync?.mode === "import",
  },
  "@/lib/issues/pull-requests": {},
})
const raw = (n) => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  html_url: `https://github.com/a/r/issues/${n}`,
  created_at: new Date(1700000000000 + n * 1000).toISOString(),
  updated_at: new Date(1700000000000 + n * 1000).toISOString(),
})
function dependencies(client, rows) {
  return {
    resolveOctokit: async () => client,
    latestMirroredUpdate: async () =>
      rows.size ? Math.max(...[...rows.values()].map((r) => r.updatedAt)) : undefined,
    repoMirrorEtag: async () => undefined,
    upsertGithubIssues: async (batch) => batch.forEach((r) => rows.set(r.number, r)),
    pruneRepoMirror: async (_, keep) => {
      let count = 0
      for (const n of rows.keys())
        if (!keep.has(n)) {
          rows.delete(n)
          count++
        }
      return count
    },
  }
}
;(async () => {
  const report = []
  const rows404 = new Map([
    [1, { number: 1, updatedAt: 1 }],
    [2, { number: 2, updatedAt: 2 }],
  ])
  const client404 = {
    request: async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 })
    },
  }
  const result404 = await syncModule.syncRepoIssues(
    { repoFullName: "a/r", issueProjectId: "test", full: true },
    dependencies(client404, rows404)
  )
  assert.equal(result404.removed, 2)
  report.push({
    case: "HTTP 404 full refresh erases cached mirror",
    result: result404,
    remaining: rows404.size,
  })

  const all = Array.from({ length: 1001 }, (_, i) => raw(1001 - i))
  const clientPages = {
    request: async (_, p) => {
      const eligible = all.filter(
        (r) => !p.since || Date.parse(r.updated_at) >= Date.parse(p.since)
      )
      const start = (p.page - 1) * p.per_page
      return {
        status: 200,
        headers:
          start + p.per_page < eligible.length
            ? { link: '<https://api.github.com/next>; rel="next"' }
            : {},
        data: eligible.slice(start, start + p.per_page),
      }
    },
  }
  const rowsPages = new Map()
  const deps = dependencies(clientPages, rowsPages)
  const first = await syncModule.syncRepoIssues(
    { repoFullName: "a/r", issueProjectId: "test", full: true },
    deps
  )
  const second = await syncModule.syncRepoIssues(
    { repoFullName: "a/r", issueProjectId: "test" },
    deps
  )
  assert.equal(first.truncated, true)
  assert.equal(rowsPages.size, 1000)
  assert.equal(rowsPages.has(1), false)
  report.push({
    case: "1001 issues never complete after truncated import and incremental refresh",
    first,
    second,
    imported: rowsPages.size,
    missing: [1],
  })

  const binding = {
    providerId: "github",
    projectId: "workspace",
    issueProjectId: "container",
    projectKey: "TEST",
    key: "a/r",
    resource: {
      kind: "github-repo",
      repoFullName: "a/r",
      sync: { mode: "import", projectV2Number: 1 },
    },
  }
  const clientProject = {
    request: async (route) => {
      if (route === "POST /graphql")
        return {
          status: 200,
          headers: {},
          data: {
            data: {
              repository: {
                projectV2: {
                  fields: { nodes: [] },
                  items: {
                    nodes: [
                      {
                        content: { number: 7, repository: { nameWithOwner: "a/r" } },
                        fieldValues: { nodes: [{ iterationId: "right-iteration" }] },
                      },
                      {
                        content: { number: 7, repository: { nameWithOwner: "b/other" } },
                        fieldValues: { nodes: [{ iterationId: "foreign-iteration" }] },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          },
        }
      if (route.endsWith("/issues")) return { status: 200, headers: {}, data: [raw(7)] }
      return { status: 200, headers: {}, data: [] }
    },
  }
  const provider = providerModule.createGithubSyncProvider({
    resolveOctokitOrNull: async () => clientProject,
    execute: async () => ({ status: "succeeded" }),
    resolveAccount: async () => ({ id: "synthetic" }),
  })
  const projectPull = await provider.pull(binding, {})
  assert.equal(projectPull.items[0].cycleExternalId, "iteration/foreign-iteration")
  report.push({
    case: "Projects v2 cross-repository same-number collision",
    received: projectPull.items[0].cycleExternalId,
    expected: "iteration/right-iteration",
  })

  let sends = 0
  const pushProvider = providerModule.createGithubSyncProvider({
    resolveOctokitOrNull: async () => clientProject,
    execute: async () => {
      sends++
      return { status: "succeeded" }
    },
    resolveAccount: async () => ({ id: "synthetic" }),
  })
  const pushResult = await pushProvider.push(
    binding,
    { externalId: "a/r#7" },
    { cycleExternalId: "iteration/new" },
    {},
    { idempotencyKey: "synthetic" }
  )
  assert.equal(sends, 0)
  assert.equal(pushResult.status, "applied")
  report.push({
    case: "Iteration change is reported applied with no remote write",
    pushResult,
    remoteWrites: sends,
  })

  const milestoneKeys = ["a/r", "b/other"].map((repo) => ({
    repo,
    externalId: providerModule.milestoneExternalId(1),
  }))
  assert.equal(milestoneKeys[0].externalId, milestoneKeys[1].externalId)
  report.push({
    case: "Different repositories produce same globally-indexed milestone key",
    milestoneKeys,
  })
  const storedCycles = new Map()
  const cycleTable = {
    add: async (row) => storedCycles.set(row.id, row),
    get: async (id) => storedCycles.get(id),
    put: async (row) => storedCycles.set(row.id, row),
    where: (key) => ({
      equals: (value) => ({
        first: async () =>
          [...storedCycles.values()].find((r) =>
            Array.isArray(r[key]) ? r[key].includes(value) : r[key] === value
          ),
        toArray: async () =>
          [...storedCycles.values()].filter((r) =>
            Array.isArray(r[key]) ? r[key].includes(value) : r[key] === value
          ),
      }),
    }),
  }
  const db = { issueCycles: cycleTable, transaction: async (...args) => args.at(-1)() }
  const issueTypes = {
    externalKeyOf: (r) => `${r.provider}:${r.externalId}`,
    ISSUE_SYNC_FIELDS: [],
    syncActorFor: () => ({ kind: "agent" }),
  }
  const actualCycles = load("lib/db/issue-cycles.ts", {
    "@/types/issues": issueTypes,
    "./schema": { getDb: () => db },
    "@/lib/sync/tombstones": {},
  })
  const engine = load("lib/issues/sync/engine.ts", {
    "@/lib/db/issues": { mapIssuesByExternalProvider: async () => new Map() },
    "@/lib/db/issue-cycles": actualCycles,
    "@/lib/db/issue-events": {},
    "@/lib/db/issue-runs": {},
    "@/lib/db/labels": { listLabels: async () => [] },
    "@/lib/db/schema": { getDb: () => db },
    "@/types/issues": issueTypes,
    "./apply": {},
    "./field-clock": {},
  })
  const cycleProvider = {
    id: "github",
    pushFields: [],
    pull: async (b) => ({
      items: [],
      cycles: [
        { externalId: providerModule.milestoneExternalId(1), kind: "milestone", name: b.key },
      ],
      notModified: false,
    }),
  }
  await engine.reconcileBinding({ ...binding, key: "a/r" }, cycleProvider, { full: true })
  await engine.reconcileBinding(
    { ...binding, key: "b/other", projectId: "other-workspace", issueProjectId: "other-container" },
    cycleProvider,
    { full: true }
  )
  assert.equal(storedCycles.size, 1)
  const collided = [...storedCycles.values()][0]
  assert.equal(collided.projectId, "workspace")
  assert.equal(collided.name, "b/other")
  report.push({
    case: "Actual sync engine overwrites first workspace milestone with second repository milestone",
    count: storedCycles.size,
    retainedWorkspace: collided.projectId,
    name: collided.name,
    binding: collided.externalRefs[0].meta.binding,
  })
  fs.writeFileSync(path.join(__dirname, "issue-probes.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
