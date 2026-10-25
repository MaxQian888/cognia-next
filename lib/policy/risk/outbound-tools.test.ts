import {
  isOutboundToolId,
  normalizeToolId,
  OUTBOUND_TOOL_IDS,
  OUTBOUND_TOOLS_OUTSIDE_RISK,
  RISK_EXTERNAL_SEND_TOOL_IDS,
  mayBeOutboundCall,
  mayWriteToGithub,
  SHELL_TOOL_IDS,
} from "./outbound-tools"

describe("normalizeToolId", () => {
  it("keeps the last `__` segment, trimmed and lowercased", () => {
    expect(normalizeToolId("mcp__cognia-tools__Send_Email ")).toBe("send_email")
    expect(normalizeToolId("im_broadcast")).toBe("im_broadcast")
    expect(normalizeToolId("  DEPLOY_SITE")).toBe("deploy_site")
  })
})

describe("outbound tool lists", () => {
  it("pins the risk classifier's external-send set", () => {
    expect([...RISK_EXTERNAL_SEND_TOOL_IDS].sort()).toEqual([
      "connector_send",
      "deploy_site",
      "filespace_enable_webdav",
      "filespace_share",
      "send_email",
      "send_message",
    ])
  })

  // The deliberate gap between the two consumers: outbound tools the risk
  // classifier does not count yet (see the module comment). Shrinking it means
  // moving an id into the risk set, which changes plan gating; growing it
  // means a new outbound tool the classifier should probably count.
  it("pins the outbound tools outside the risk set", () => {
    expect([...OUTBOUND_TOOLS_OUTSIDE_RISK].sort()).toEqual([
      "connectors_send_message",
      "im_broadcast",
      "im_create_chat",
      "im_dispatch_task",
      "team_post_to_chat",
    ])
    for (const id of OUTBOUND_TOOLS_OUTSIDE_RISK) {
      expect(RISK_EXTERNAL_SEND_TOOL_IDS.has(id)).toBe(false)
    }
  })

  it("reviews exactly the union of both lists", () => {
    expect(OUTBOUND_TOOL_IDS.size).toBe(
      RISK_EXTERNAL_SEND_TOOL_IDS.size + OUTBOUND_TOOLS_OUTSIDE_RISK.size
    )
    for (const id of [...RISK_EXTERNAL_SEND_TOOL_IDS, ...OUTBOUND_TOOLS_OUTSIDE_RISK]) {
      expect(OUTBOUND_TOOL_IDS.has(id)).toBe(true)
    }
  })

  it("keeps self-addressed and membership-only tools out", () => {
    for (const id of [
      "send_session_message",
      "team_send_message",
      "im_invite_members",
      "im_remove_members",
      "im_update_chat",
      "im_resolve_contact",
      "build_site",
      "filespace_list",
    ]) {
      expect(isOutboundToolId(id)).toBe(false)
    }
  })

  it("matches MCP wire names", () => {
    expect(isOutboundToolId("mcp__cognia-skills__im_broadcast")).toBe(true)
    expect(isOutboundToolId("mcp__cognia-team__team_post_to_chat")).toBe(true)
  })
})

describe("mayWriteToGithub (ADR-0239 phase 2)", () => {
  it("is true for shell tools and integration actions, by name only", () => {
    for (const name of [
      "Bash",
      "mcp__cognia-tools__sandbox_bash",
      "shell_execute_advanced",
      "start_process",
      "integration__github-delivery__github__commentpr",
      "mcp__cognia-plugin-tools__integration__github-delivery__github__mergepr",
    ]) {
      expect(mayWriteToGithub(name)).toBe(true)
    }
    for (const name of ["Read", "send_email", "mcp__github__create_issue", "my_integration_tool"]) {
      expect(mayWriteToGithub(name)).toBe(false)
    }
    expect([...SHELL_TOOL_IDS].sort()).toEqual(
      ["bash", "sandbox_bash", "shell_execute_advanced", "start_process"].sort()
    )
  })

  it("passes a shell call on only when its arguments mention gh", () => {
    expect(mayWriteToGithub("Bash", { command: "gh pr create" })).toBe(true)
    expect(mayWriteToGithub("Bash", { command: "cd x && gh api -X POST y" })).toBe(true)
    expect(mayWriteToGithub("start_process", { program: "gh", args: ["pr", "merge"] })).toBe(true)
    expect(mayWriteToGithub("Bash", { command: "ls -la" })).toBe(false)
    expect(mayWriteToGithub("Bash", { command: "echo ghost" })).toBe(false)
    expect(mayWriteToGithub("integration__p__github__mergepr", {})).toBe(true)
  })

  it("adds GitHub candidates to the outbound tools for a cheap gate", () => {
    expect(mayBeOutboundCall("im_broadcast")).toBe(true)
    expect(mayBeOutboundCall("Bash")).toBe(true)
    expect(mayBeOutboundCall("Read")).toBe(false)
  })
})
