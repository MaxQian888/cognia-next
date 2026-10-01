/* eslint-disable @typescript-eslint/no-require-imports, @next/next/no-assign-module-variable -- standalone CommonJS audit probe run directly by node, not app code */
// Read-only synthetic probes. No network, Git writes, auth stores, or source edits.
// Run from the repo: rtk node /tmp/cognia-repository-audit-2026-10-01/forge-probes.cjs
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const root = process.argv[2] || "/Users/bytedance/Project/cognia-next"
const ts = require(path.join(root, "node_modules/typescript"))
function load(rel, deps) {
  const exports = {}
  const module = { exports }
  const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(code, {
    exports,
    module,
    require: (name) => {
      if (name in deps) return deps[name]
      throw new Error("Unexpected dependency " + name)
    },
    console,
    Map,
    Set,
    Date,
    Error,
    URL,
  })
  return module.exports
}
// The hash dependency is unused on these production code paths.
const contracts = load("lib/review/contracts.ts", { "@/lib/share/hash": {} })
const bundle = load("lib/review/bundle.ts", { "./contracts": contracts })
const pushes = []
const requests = []
const providerModule = load("lib/review/github-provider.ts", {
  "@/lib/git/commands": { gitPush: async (...args) => pushes.push(args) },
  "./bundle": bundle,
})
const runtime = load("lib/review/github-runtime.ts", {
  "@/lib/tauri": { isTauri: () => true },
  "@/lib/ai/agent/team/pr-feedback/resolvers": {},
  "./github-provider": providerModule,
})
async function main() {
  const client = {
    request: async (...args) => {
      requests.push(args)
      return { status: 200, data: [] }
    },
  }
  const enterprise = runtime.createGitHubPullRequestProvider({
    isLocalRuntime: () => true,
    getToken: async () => null,
    resolveRepository: async () => ({
      fullName: "acme/repo",
      defaultBranch: "main",
      host: {
        id: "ghe.example",
        webBaseUrl: "https://ghe.example",
        apiBaseUrl: "https://ghe.example/api/v3",
      },
    }),
    resolveClient: async () => client,
  })
  console.log("GHES-only authenticationState:", await enterprise.getAuthenticationState())
  await enterprise.findForBranch("/repo", "feature")
  console.log("GHES direct lookup with valid host client succeeded:", requests.length === 1)
  const provider = new providerModule.GitHubPullRequestProvider({
    authenticationState: async () => "authenticated",
    resolveRepository: async () => ({
      owner: "new-owner",
      repo: "new-repo",
      fullName: "new-owner/new-repo",
      client,
    }),
  })
  await provider.push("/upstream-only", "feature")
  console.log("Push remote despite resolved repo:", JSON.stringify(pushes[0]))
  const pr = {
    provider: "github",
    repository: "old-owner/old-repo",
    number: 42,
    url: "https://github.com/old-owner/old-repo/pull/42",
    headRef: "feature",
    baseRef: "main",
    title: "Original",
    state: "open",
  }
  await provider.publishFeedback(pr, {
    id: "b",
    sessionId: "s",
    scope: "branch",
    repositoryRoots: ["/repo"],
    summary: "Old repo review",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
    comments: [
      {
        id: "c",
        contentHash: "h",
        anchor: {
          repositoryRoot: "/repo",
          path: "a.ts",
          hunkHash: "h",
          side: "after",
          line: 1,
          commitSha: "a".repeat(40),
        },
        body: "Review",
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  console.log(
    "Cached PR repo:",
    pr.repository,
    "published request:",
    JSON.stringify(requests.at(-1))
  )

  const accounts = [
    {
      id: "new-ghes",
      enabled: true,
      providerId: "github-pat",
      authSessionId: "ghes",
      label: "Enterprise",
    },
    {
      id: "old-dotcom",
      enabled: true,
      providerId: "github-pat",
      authSessionId: "dotcom",
      label: "GitHub.com",
    },
  ]
  const writeback = load("lib/issues/github-writeback.ts", {
    "@/lib/integrations/action-runner": {},
    "@/lib/db/integrations": { listIntegrationAccounts: async () => accounts },
  })
  const plugin = load("plugins/github-delivery/src/index.ts", {
    "@cognia/plugin-sdk": {
      definePlugin: (value) => value,
      definePluginManifest: (value) => value,
    },
    "../plugin.json": JSON.parse(
      fs.readFileSync(path.join(root, "plugins/github-delivery/plugin.json"), "utf8")
    ),
  })
  const chosen = await writeback.resolveGithubWritebackAccount()
  const target = { repoFullName: "acme/repo", number: 42 }
  const action = writeback.toIntegrationAction(target, {
    kind: "comment",
    body: "From github.com issue",
  })
  const externalRequests = []
  // Mirrors action-runner.ts:420: apiBaseUrl comes from the selected account session.
  const apiBaseUrl =
    chosen.authSessionId === "ghes" ? "https://ghe.example/api/v3" : "https://api.github.com"
  await plugin.commentIssue(action.input, {
    apiBaseUrl,
    authenticatedRequest: async (...args) => {
      externalRequests.push(args)
      return { status: 201, headers: {}, data: { id: 1 } }
    },
  })
  console.log("Writeback selected account:", chosen.id, "input:", JSON.stringify(action))
  console.log("Writeback destination for public issue:", JSON.stringify(externalRequests))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
