import {
  __resetIntegrationRegistryForTesting,
  integrationToolName,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import type { IntegrationActionDef, PluginIntegrationDef } from "@/types/plugin/plugin-integration"

import {
  githubActionTargets,
  githubRequestTargets,
  githubToolCallTargets,
  githubWebHost,
  githubWriteActionOf,
  isGithubIntegration,
  isGithubWriteCall,
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

  it("names a bare repository on the account's host", () => {
    expect(
      githubActionTargets(
        commentPr,
        { repoFullName: "acme/web", prNumber: 4 },
        { host: "ghe.corp.io" }
      )
    ).toEqual([repositoryTarget("ghe.corp.io/acme/web", 4)])
    expect(
      githubActionTargets(commentPr, { repoFullName: "acme/web" }, { host: "github.com" })
    ).toEqual([repositoryTarget("acme/web")])
    expect(
      githubActionTargets(
        commentPr,
        { repoFullName: "https://github.com/acme/web" },
        { host: "ghe.corp.io" }
      )
    ).toEqual([repositoryTarget("acme/web")])
  })
})

describe("githubWebHost", () => {
  it("is github.com for the public API and the server's own host for GitHub Enterprise", () => {
    expect(githubWebHost()).toBe("github.com")
    expect(githubWebHost("https://api.github.com")).toBe("github.com")
    expect(githubWebHost("https://GHE.corp.io/api/v3")).toBe("ghe.corp.io")
    expect(githubWebHost("not a url")).toBe("github.com")
  })
})

describe("githubRequestTargets", () => {
  it("reads the repository and thread from a /repos path", () => {
    expect(githubRequestTargets("https://api.github.com/repos/Acme/Web/pulls")).toEqual([
      repositoryTarget("acme/web"),
    ])
    expect(
      githubRequestTargets("https://api.github.com/repos/acme/web/issues/12/comments")
    ).toEqual([repositoryTarget("acme/web", 12)])
    expect(githubRequestTargets("https://api.github.com/repos/acme/web/pulls/9/merge")).toEqual([
      repositoryTarget("acme/web", 9),
    ])
    expect(
      githubRequestTargets("https://api.github.com/repos/acme/web/issues/comments/55")
    ).toEqual([repositoryTarget("acme/web")])
  })

  it("reads a GitHub Enterprise path relative to its API root", () => {
    expect(
      githubRequestTargets(
        "https://ghe.corp.io/api/v3/repos/acme/web/pulls",
        "https://ghe.corp.io/api/v3"
      )
    ).toEqual([repositoryTarget("ghe.corp.io/acme/web")])
    expect(
      githubRequestTargets("https://ghe.corp.io/repos/acme/web/pulls", "https://ghe.corp.io/api/v3")
    ).toEqual([unknownGithubTarget()])
  })

  it("is unknown for anything that is not one repository's", () => {
    for (const url of [
      "https://api.github.com/graphql",
      "https://api.github.com/gists",
      "https://api.github.com/user/repos",
      "https://api.github.com/repos/acme",
      "https://api.github.com/repos/acme%2Fweb/x/pulls",
      "https://evil.example/repos/acme/web/pulls",
      "not a url",
    ]) {
      expect(githubRequestTargets(url)).toEqual([unknownGithubTarget()])
    }
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

describe("isGithubWriteCall", () => {
  it("is a GitHub write tool, or a shell call with a gh write", () => {
    expect(isGithubWriteCall(tool("github-delivery", "github", "commentPr"), {})).toBe(true)
    expect(isGithubWriteCall(tool("github-delivery", "github", "getIssue"), {})).toBe(false)
    expect(isGithubWriteCall("Bash", { command: "gh issue close 3" })).toBe(true)
    expect(isGithubWriteCall("Bash", { command: "gh issue view 3" })).toBe(false)
    expect(isGithubWriteCall("Read", { command: "gh issue close 3" })).toBe(false)
  })
})

describe("isGithubIntegration", () => {
  it("is the github integration, or one with a GitHub operation", () => {
    expect(isGithubIntegration(definition("github", []))).toBe(true)
    expect(
      isGithubIntegration(
        definition("forge", [{ ...action("c", "write"), operationId: "github.commentPr" }])
      )
    ).toBe(true)
    expect(isGithubIntegration(definition("issues", [action("c", "write")]))).toBe(false)
  })
})
