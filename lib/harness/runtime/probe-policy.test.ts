import { validateAgentCapabilityGrant } from "@cognia/agent-config-types/agent-capability-grant"
import {
  PROBE_DENIED_TOOLS,
  decideProbeShellCommand,
  decideProbeToolCall,
  isInsideRoot,
  pathsInPatch,
  pathsInToolInput,
  probeCapabilityGrant,
  probePluginToolDenials,
  resolveProbePath,
  splitProbeToolName,
  type ProbePolicyContext,
} from "./probe-policy"

const ROOT = "/data/harness-evolution/run-1/base1"

const ctx = (over: Partial<ProbePolicyContext> = {}): ProbePolicyContext => ({
  isolation: "files",
  root: ROOT,
  home: "/Users/me",
  networkOff: false,
  allowedMcpServerNames: new Set(["docs"]),
  ...over,
})

describe("probeCapabilityGrant", () => {
  const policy = { allowedMcpServerIds: ["mcp-b", "mcp-a"], networkOff: false }

  it("caps the mode, carries the unattended profile and keeps only declared MCP servers", () => {
    const grant = probeCapabilityGrant({
      runId: "run-1",
      label: "base1",
      isolation: "files",
      policy,
      maxTurns: 250,
      maxBudgetUsd: 0.5,
      executor: { providerId: "openai", model: "gpt-x" },
    })
    expect(validateAgentCapabilityGrant(grant).ok).toBe(true)
    expect(grant.model).toBe("gpt-x")
    expect(grant.provider).toBe("openai")
    expect(grant.source).toEqual({ kind: "harness-evolution", id: "run-1:base1" })
    expect(grant.permissionMode).toBe("default")
    expect(grant.permissionProfile).toEqual({
      workspace: "sandbox",
      outbound: "deny",
      secrets: "deny",
      hostConfig: "deny",
    })
    expect(grant.maxTurns).toBe(100)
    expect(grant.maxBudgetUsd).toBe(0.5)
    expect(grant.mcpServers).toEqual({ only: ["mcp-a", "mcp-b"] })
    expect(grant.tools?.deny).toEqual(
      expect.arrayContaining(["get_env", "mcp__cognia-tools__get_env"])
    )
    expect(grant.tools?.deny).toContain("mcp__cognia-plugin-tools__artifact_create")
    expect(grant.tools?.deny).not.toContain("Bash")
    expect(grant.tools?.deny).not.toContain("web_search")
  })

  it("denies the web when the network is cut and every writer without a directory", () => {
    const grant = probeCapabilityGrant({
      runId: "r",
      label: "inv1",
      isolation: "none",
      policy: { allowedMcpServerIds: [], networkOff: true },
      maxTurns: 0,
      pluginToolDenials: ["mcp__cognia-plugin-tools__pet_say"],
    })
    expect(grant.maxTurns).toBe(1)
    expect(grant.maxBudgetUsd).toBeUndefined()
    expect(grant.model).toBeUndefined()
    expect(grant.tools?.deny).toEqual(
      expect.arrayContaining([
        "WebFetch",
        "web_search",
        "mcp__cognia-plugin-tools__web_fetch",
        "Bash",
        "Write",
        "mcp__cognia-tools__write",
        "mcp__cognia-tools__git_commit",
        "mcp__cognia-plugin-tools__pet_say",
      ])
    )
    expect(validateAgentCapabilityGrant(grant).ok).toBe(true)
  })

  it("lists denied tools in both bare and namespaced form", () => {
    expect(PROBE_DENIED_TOOLS).toContain("dispatch_agent")
    expect(PROBE_DENIED_TOOLS).toContain("mcp__cognia-plugin-tools__dispatch_agent")
    expect(PROBE_DENIED_TOOLS).toContain("mcp__a2ui-bridge__a2ui_handle_connector_action")
  })
})

describe("probePluginToolDenials", () => {
  it("denies every manifest tool off the allowlist", () => {
    expect(
      probePluginToolDenials([
        { name: "load_skill" },
        { name: "github_comment" },
        { name: "clipboard_write_text" },
        { name: "github_comment" },
        { name: "web_fetch" },
      ])
    ).toEqual([
      "clipboard_write_text",
      "mcp__cognia-plugin-tools__clipboard_write_text",
      "github_comment",
      "mcp__cognia-plugin-tools__github_comment",
    ])
    expect(probePluginToolDenials(undefined)).toEqual([])
  })
})

describe("paths", () => {
  it("splits namespaced tool names", () => {
    expect(splitProbeToolName("mcp__cognia-tools__write")).toEqual({
      server: "cognia-tools",
      bare: "write",
    })
    expect(splitProbeToolName("Write")).toEqual({ bare: "Write" })
    expect(splitProbeToolName("mcp__broken")).toEqual({ bare: "mcp__broken" })
  })

  it("resolves relative, home and absolute paths and tests containment", () => {
    expect(resolveProbePath("out/report.md", ROOT)).toBe(`${ROOT}/out/report.md`)
    expect(resolveProbePath("../escape", ROOT)).toBe("/data/harness-evolution/run-1/escape")
    expect(resolveProbePath("~/x", ROOT, "/Users/me")).toBe("/Users/me/x")
    expect(resolveProbePath("~/x", ROOT)).toBeUndefined()
    expect(resolveProbePath("file:///etc/hosts", ROOT)).toBe("/etc/hosts")
    expect(resolveProbePath("  ", ROOT)).toBeUndefined()
    expect(isInsideRoot(`${ROOT}/a`, ROOT)).toBe(true)
    expect(isInsideRoot(ROOT, `${ROOT}/`)).toBe(true)
    expect(isInsideRoot(`${ROOT}-other/a`, ROOT)).toBe(false)
    expect(isInsideRoot("c:/Data/p/a", "C:\\Data\\p")).toBe(true)
    expect(resolveProbePath("C:\\Data\\p\\..\\q", ROOT)).toBe("c:/Data/q")
  })

  it("finds paths in tool inputs and patches", () => {
    expect(
      pathsInToolInput({
        file_path: "a.md",
        edits: [{ old_string: "x", new_string: "y" }],
        options: { destination: "b.md" },
        paths: ["c", 3],
      }).sort()
    ).toEqual(["a.md", "b.md", "c"])
    expect(pathsInToolInput("nope")).toEqual([])
    expect(
      pathsInPatch(
        [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "*** Move to: src/b.ts",
          "*** Add File: /etc/evil",
          "--- a/lib/x.ts",
          "+++ b/lib/x.ts\t2020",
          "--- /dev/null",
        ].join("\n")
      ).sort()
    ).toEqual(["/etc/evil", "lib/x.ts", "src/a.ts", "src/b.ts"])
  })
})

describe("decideProbeShellCommand", () => {
  it.each([
    ["pnpm test", true],
    ["node build.js && cat out.txt", true],
    ["rm -rf dist", true],
    ["echo hi > notes.md", true],
    ["echo hi > /dev/null", true],
    ["ls /usr/bin", true],
    ["cd sub && ls", true],
    ["git commit -m wip", true],
    ["git push origin main", false],
    ["git config --global user.name x", false],
    ["sudo ls", false],
    ["ssh host", false],
    ["printenv", false],
    ["env", false],
    ["echo $OPENAI_API_KEY", false],
    ["npm publish", false],
    ["npm install -g x", false],
    ["pip install requests", false],
    ["cat ~/.ssh/id_rsa", false],
    ["cat ../../secrets", false],
    ["cp a.txt /tmp/x", false],
    ["echo x > /etc/hosts", false],
    ["cd / && ls", false],
    ["curl -X POST https://example.com", false],
    ["docker run x", false],
    ["rm -rf /", false],
  ])("%s → %s", (command, allowed) => {
    expect(decideProbeShellCommand(command, ctx()).allow).toBe(allowed)
  })

  it("cuts network commands and installs when the network is off", () => {
    expect(decideProbeShellCommand("curl https://example.com", ctx()).allow).toBe(true)
    expect(
      decideProbeShellCommand("curl https://example.com", ctx({ networkOff: true })).allow
    ).toBe(false)
    expect(decideProbeShellCommand("pnpm install", ctx()).allow).toBe(true)
    expect(decideProbeShellCommand("pnpm install", ctx({ networkOff: true })).allow).toBe(false)
    expect(decideProbeShellCommand("npx tsc", ctx({ networkOff: true })).allow).toBe(false)
  })

  it("refuses without a working directory", () => {
    expect(decideProbeShellCommand("ls", ctx({ root: undefined }))).toEqual({
      allow: false,
      reason: expect.stringMatching(/no working directory/),
    })
  })
})

describe("decideProbeToolCall", () => {
  it("lets file writes through only inside the probe directory", () => {
    expect(decideProbeToolCall("Write", { file_path: "report.md" }, ctx()).allow).toBe(true)
    expect(decideProbeToolCall("Write", { file_path: "/Users/me/report.md" }, ctx()).allow).toBe(
      false
    )
    expect(
      decideProbeToolCall(
        "mcp__cognia-tools__file_copy",
        { source: "a", destination: "../b" },
        ctx()
      ).allow
    ).toBe(false)
    expect(decideProbeToolCall("mcp__cognia-tools__write", {}, ctx()).allow).toBe(false)
    expect(
      decideProbeToolCall(
        "mcp__cognia-tools__apply_patch",
        { patch: "*** Update File: /etc/hosts" },
        ctx()
      ).allow
    ).toBe(false)
    expect(
      decideProbeToolCall("mcp__cognia-tools__apply_patch", { patch: "*** Add File: a.md" }, ctx())
        .allow
    ).toBe(true)
    expect(decideProbeToolCall("Edit", { file_path: "a" }, ctx({ root: undefined })).allow).toBe(
      false
    )
  })

  it("judges shell calls by their command", () => {
    expect(decideProbeToolCall("Bash", { command: "pnpm test" }, ctx()).allow).toBe(true)
    expect(
      decideProbeToolCall("mcp__cognia-tools__bash", { command: "git push" }, ctx()).allow
    ).toBe(false)
    expect(decideProbeToolCall("Bash", {}, ctx()).allow).toBe(false)
  })

  it("allows git writes only in a git probe", () => {
    expect(
      decideProbeToolCall("mcp__cognia-tools__git_commit", { message: "x" }, ctx()).allow
    ).toBe(false)
    expect(
      decideProbeToolCall(
        "mcp__cognia-tools__git_commit",
        { message: "x" },
        ctx({ isolation: "git" })
      ).allow
    ).toBe(true)
  })

  it("keeps reads inside the directory", () => {
    expect(decideProbeToolCall("Read", { file_path: "a.md" }, ctx()).allow).toBe(true)
    expect(
      decideProbeToolCall("Read", { file_path: "/Users/me/.aws/credentials" }, ctx()).allow
    ).toBe(false)
    expect(decideProbeToolCall("Read", { file_path: "a.md" }, ctx({ root: undefined })).allow).toBe(
      false
    )
  })

  it("routes plugin, A2UI, web and MCP tools", () => {
    expect(decideProbeToolCall("mcp__cognia-plugin-tools__load_skill", {}, ctx()).allow).toBe(true)
    expect(decideProbeToolCall("mcp__cognia-plugin-tools__artifact_create", {}, ctx()).allow).toBe(
      false
    )
    expect(
      decideProbeToolCall("mcp__cognia-plugin-tools__web_fetch", {}, ctx({ networkOff: true }))
        .allow
    ).toBe(false)
    expect(decideProbeToolCall("WebFetch", {}, ctx()).allow).toBe(true)
    expect(decideProbeToolCall("WebFetch", {}, ctx({ networkOff: true })).allow).toBe(false)
    expect(decideProbeToolCall("mcp__a2ui-bridge__a2ui_create_surface", {}, ctx()).allow).toBe(true)
    expect(
      decideProbeToolCall("mcp__a2ui-bridge__a2ui_handle_connector_action", {}, ctx()).allow
    ).toBe(false)
    expect(decideProbeToolCall("mcp__docs__search", {}, ctx()).allow).toBe(true)
    expect(decideProbeToolCall("mcp__github__create_issue", {}, ctx())).toEqual({
      allow: false,
      reason: 'MCP server "github" is not declared safe to probe.',
    })
    expect(decideProbeToolCall("TodoWrite", {}, ctx()).allow).toBe(true)
    expect(decideProbeToolCall("mcp__cognia-tools__terminate_process", {}, ctx())).toEqual({
      allow: false,
      reason: '"terminate_process" is not on the probe allowlist.',
    })
  })
})
