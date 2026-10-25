import {
  __resetIntegrationRegistryForTesting,
  integrationToolName,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import type { IntegrationActionDef, PluginIntegrationDef } from "@/types/plugin/plugin-integration"

import {
  githubActionTargets,
  githubToolCallTargets,
  githubWriteActionOf,
  isGithubWriteTool,
} from "./github-targets"
import { repositoryTarget, unknownGithubTarget } from "./outbound-targets"

const REPO_SELECTOR = [{ kind: "repository", jsonPointer: "/repoFullName" }]

function action(id: string, risk: IntegrationActionDef["risk"]): IntegrationActionDef {
  return {
    id,
    label: id,
    handler: id,
    inputSchema: {},
    risk,
    idempotency: risk === "read" ? "supported" : "required",
    scopeSelectors: REPO_SELECTOR,
  }
}

function definition(id: string, actions: IntegrationActionDef[]): PluginIntegrationDef {
  return { id, label: id, authStrategies: [], resourceKinds: [], eventTypes: [], actions }
}

function register(pluginId: string, def: PluginIntegrationDef) {
  registerIntegrationDefinitions({
    pluginId,
    definitions: [def],
    handlers: Object.fromEntries(def.actions.map((a) => [`${def.id}:${a.id}`, async () => ({})])),
  })
}

beforeEach(() => {
  __resetIntegrationRegistryForTesting()
  register(
    "github-delivery",
    definition("github", [
      action("commentPr", "write"),
      action("mergePr", "destructive"),
      action("getIssue", "read"),
      action("updateComment", "write"),
    ])
  )
  register("tracker", definition("issues", [action("commentPr", "write")]))
  register("forge", {
    ...definition("forge", [{ ...action("comment", "write"), operationId: "github.commentPr" }]),
  })
})

const tool = (plugin: string, def: string, act: string) =>
  `mcp__cognia-plugin-tools__${integrationToolName(plugin, def, act)}`

describe("GitHub write tools", () => {
  it("are a GitHub integration's actions that are not read-only", () => {
    expect(isGithubWriteTool(tool("github-delivery", "github", "commentPr"))).toBe(true)
    expect(isGithubWriteTool(integrationToolName("github-delivery", "github", "mergePr"))).toBe(
      true
    )
    expect(isGithubWriteTool(tool("github-delivery", "github", "getIssue"))).toBe(false)
    expect(isGithubWriteTool(tool("forge", "forge", "comment"))).toBe(true)
  })

  it("are never decided by the short name", () => {
    expect(isGithubWriteTool(tool("tracker", "issues", "commentPr"))).toBe(false)
    expect(isGithubWriteTool("mcp__github__commentpr")).toBe(false)
    expect(isGithubWriteTool("commentpr")).toBe(false)
    expect(isGithubWriteTool("Bash")).toBe(false)
  })

  it("name the action they call", () => {
    expect(githubWriteActionOf(tool("github-delivery", "github", "mergePr"))).toMatchObject({
      pluginId: "github-delivery",
      action: { id: "mergePr", risk: "destructive" },
    })
  })
})

describe("githubActionTargets", () => {
  const commentPr = action("commentPr", "write")

  it("writes to the repository at the scope selector, on the PR or issue it names", () => {
    expect(githubActionTargets(commentPr, { repoFullName: "Acme/Web", prNumber: 12 })).toEqual([
      repositoryTarget("acme/web", 12),
    ])
    expect(githubActionTargets(commentPr, { repoFullName: "acme/web", issueNumber: "7" })).toEqual([
      repositoryTarget("acme/web", 7),
    ])
  })

  it("has no thread for a comment id alone, and is unknown without a valid repository", () => {
    expect(githubActionTargets(commentPr, { repoFullName: "acme/web", commentId: 99 })).toEqual([
      repositoryTarget("acme/web"),
    ])
    expect(githubActionTargets(commentPr, { prNumber: 3 })).toEqual([unknownGithubTarget()])
    expect(githubActionTargets(commentPr, { repoFullName: "not a repo" })).toEqual([
      unknownGithubTarget(),
    ])
    expect(githubActionTargets({ ...commentPr, scopeSelectors: [] }, {})).toEqual([
      unknownGithubTarget(),
    ])
    expect(githubActionTargets(commentPr, null)).toEqual([unknownGithubTarget()])
  })

  it("ignores a thread number that is not a positive integer", () => {
    expect(githubActionTargets(commentPr, { repoFullName: "acme/web", prNumber: -1 })).toEqual([
      repositoryTarget("acme/web"),
    ])
  })
})

describe("githubToolCallTargets", () => {
  it("gives the GitHub targets of any tool call", () => {
    expect(
      githubToolCallTargets(tool("github-delivery", "github", "commentPr"), {
        repoFullName: "acme/web",
        prNumber: 5,
      })
    ).toEqual([repositoryTarget("acme/web", 5)])
    expect(githubToolCallTargets("Bash", { command: "gh pr merge 5 -R acme/web" })).toEqual([
      repositoryTarget("acme/web", 5),
    ])
    expect(githubToolCallTargets("Bash", { command: "gh pr view 5" })).toEqual([])
    expect(githubToolCallTargets(tool("github-delivery", "github", "getIssue"), {})).toEqual([])
    expect(githubToolCallTargets("send_email", { to: "a@b.co" })).toEqual([])
  })
})
