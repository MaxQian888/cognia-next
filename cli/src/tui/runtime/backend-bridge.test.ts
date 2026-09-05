/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import {
  buildCodexOptions,
  toAcpMcpServers,
  toCodexReasoningEffort,
  toCodexSkillRoots,
} from "./backend-bridge"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const stdio = (name: string, command = "node"): McpServer =>
  ({
    id: name,
    name,
    transport: "stdio",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    config: { command, args: ["x"] },
  }) as McpServer

describe("toAcpMcpServers", () => {
  it("projects stdio and remote servers into the ACP shape", () => {
    expect(
      toAcpMcpServers([
        stdio("files"),
        {
          id: "web",
          name: "web",
          transport: "http",
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
          config: { url: "https://mcp.example", headers: { Authorization: "Bearer t" } },
        } as McpServer,
      ])
    ).toEqual([
      { name: "files", command: "node", args: ["x"] },
      {
        type: "http",
        name: "web",
        url: "https://mcp.example",
        headers: [{ name: "Authorization", value: "Bearer t" }],
      },
    ])
  })

  it("drops what an external process cannot dial rather than shipping it malformed", () => {
    expect(
      toAcpMcpServers([
        { id: "a", name: "a", transport: "stdio", enabled: true, config: {} } as McpServer,
        { id: "b", name: "b", transport: "http", enabled: true, config: {} } as McpServer,
      ])
    ).toEqual([])
  })

  it("does not forward disabled servers or their credentials", () => {
    expect(
      toAcpMcpServers([
        { ...stdio("disabled"), enabled: false, config: { command: "node", env: { TOKEN: "x" } } },
      ])
    ).toEqual([])
  })

  it("keeps the first of a duplicate name, since ACP keys by name", () => {
    expect(toAcpMcpServers([stdio("dup", "first"), stdio("dup", "second")])).toEqual([
      { name: "dup", command: "first", args: ["x"] },
    ])
  })

  it("forwards nothing when nothing is configured", () => {
    expect(toAcpMcpServers([])).toEqual([])
  })
})

describe("toCodexReasoningEffort", () => {
  it("forwards nothing for the model's own default", () => {
    // "off" means "don't set an effort", not "set it to off".
    expect(toCodexReasoningEffort("off")).toBeUndefined()
    expect(toCodexReasoningEffort(undefined)).toBeUndefined()
  })

  it.each(["low", "medium", "high", "xhigh", "max"] as const)("passes %s through", (level) => {
    expect(toCodexReasoningEffort(level)).toBe(level)
  })

  it("keeps only the effort half of the composite ultracode tier", () => {
    // Its other half enables in-tree plugin tools, which have no external peer.
    expect(toCodexReasoningEffort("ultracode")).toBe("xhigh")
  })
})

describe("toCodexSkillRoots", () => {
  it("hands over the configured skill directories, de-duplicated", () => {
    expect(toCodexSkillRoots({ ...config, skillDirs: ["/a", "/b", "/a"] })).toEqual(["/a", "/b"])
  })

  it("forwards nothing when external skills are switched off", () => {
    expect(toCodexSkillRoots({ ...config, skillDirs: ["/a"], externalSkills: false })).toEqual([])
  })

  it("ignores blank entries and an absent list", () => {
    expect(toCodexSkillRoots({ ...config, skillDirs: ["  ", "/a"] })).toEqual(["/a"])
    expect(toCodexSkillRoots(config)).toEqual([])
  })
})

describe("buildCodexOptions", () => {
  it("carries effort and skill roots on a Codex preset", () => {
    expect(
      buildCodexOptions(
        { ...config, thinkingLevel: "high", skillDirs: ["/skills"] },
        "codex-app-server"
      )
    ).toEqual({ defaultReasoningEffort: "high", extraSkillRoots: ["/skills"] })
  })

  it.each(["claude-code", "codex", "codex-acp"])("forwards no native options to %s", (presetId) => {
    // ACP has no metadata slot for either, so claiming support would be a lie.
    expect(
      buildCodexOptions({ ...config, thinkingLevel: "high", skillDirs: ["/s"] }, presetId)
    ).toBeUndefined()
  })

  it("omits the whole block when there is nothing to say", () => {
    expect(buildCodexOptions(config, "codex-app-server")).toBeUndefined()
  })

  it("carries just one half when only one is configured", () => {
    expect(buildCodexOptions({ ...config, thinkingLevel: "low" }, "codex-app-server")).toEqual({
      defaultReasoningEffort: "low",
    })
    expect(buildCodexOptions({ ...config, skillDirs: ["/s"] }, "codex-app-server")).toEqual({
      extraSkillRoots: ["/s"],
    })
  })
})
