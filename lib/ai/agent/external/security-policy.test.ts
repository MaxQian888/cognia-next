import {
  AGENT_STATE_ROOT_RULES,
  EXTERNAL_AGENT_BINARY_ALLOWLIST,
  EXTERNAL_AGENT_NPX_ALLOWLIST,
  agentStateWritableRoots,
  baseCommandName,
  externalAgentSandboxSupportsPlatform,
  isAgentStateFileRoot,
} from "./security-policy"

describe("sandbox platform gate", () => {
  it("allows exactly the platforms with a real sandbox", () => {
    expect(externalAgentSandboxSupportsPlatform("darwin")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("linux")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("win32")).toBe(false)
    expect(externalAgentSandboxSupportsPlatform("freebsd")).toBe(false)
  })

  it("accepts Tauri's platform spelling as well as Node's", () => {
    // The renderer asks `@tauri-apps/plugin-os`, which says "macos"/"windows";
    // the CLI asks `process.platform`, which says "darwin"/"win32". A helper
    // that only understood one of them would answer "unsupported" for macOS
    // desktop users.
    expect(externalAgentSandboxSupportsPlatform("macos")).toBe(true)
    expect(externalAgentSandboxSupportsPlatform("windows")).toBe(false)
  })
})

describe("allowlists", () => {
  it("admits the binary the claude-code preset actually spawns", () => {
    // `ecosystem-adapters.ts` launches the bare `claude-agent-acp` binary for
    // the `claude-code` preset. Rust's allowlist only carried the npx package,
    // so a headless spawn of the shipped preset was rejected by policy.
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain("claude-agent-acp")
  })

  it("carries no binary that no preset can reach", () => {
    // `cline` sat in the allowlist with no preset, no adapter and no surface —
    // pure attack surface for the headless spawn RPC.
    expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).not.toContain("cline")
  })

  it("keeps the npx bridges the presets use", () => {
    for (const pkg of ["@zed-industries/codex-acp", "@google/gemini-cli", "@qwen-code/qwen-code"]) {
      expect(EXTERNAL_AGENT_NPX_ALLOWLIST).toContain(pkg)
    }
  })

  it("no longer admits the removed Pi ACP bridge", () => {
    // Pi launches its own binary now. Re-adding the package here would restore
    // an unpinned `npx` launch that the runtime catalog no longer waives.
    expect(EXTERNAL_AGENT_NPX_ALLOWLIST).not.toContain("pi-acp")
  })
})

describe("agentStateWritableRoots", () => {
  it("resolves an npx launch to the PACKAGE's state, not npx's", () => {
    const roots = agentStateWritableRoots("npx", ["-y", "@zed-industries/codex-acp"])
    expect(roots).toContain(".codex")
    expect(roots).toContain(".npm")
  })

  it("gives OpenCode its state roots", () => {
    // Neither launcher had an OpenCode rule, so `opencode serve` ran with its
    // session store outside the sandbox scope and resume started over.
    const roots = agentStateWritableRoots("opencode")
    expect(roots).toEqual([".config/opencode", ".local/share/opencode"])
  })

  it("does not hand copilot Pi's state directory", () => {
    // "copilot" contains "pi", which is why the Pi rule matches exactly rather
    // than by substring.
    expect(agentStateWritableRoots("copilot")).not.toContain(".pi")
    expect(agentStateWritableRoots("pi")).toContain(".pi")
    // And an npx package merely containing "pi" gets nothing: the rule matches
    // the BASE command, so the removed bridge cannot reach Pi's session store.
    expect(agentStateWritableRoots("npx", ["-y", "pi-acp"])).not.toContain(".pi")
  })

  it("strips a Windows executable suffix", () => {
    expect(baseCommandName("Codex.EXE")).toBe("codex")
    expect(agentStateWritableRoots("codex.cmd")).toContain(".codex")
  })

  it("marks the claude json files as files, not directories", () => {
    expect(isAgentStateFileRoot(".claude.json")).toBe(true)
    expect(isAgentStateFileRoot(".claude.json.backup")).toBe(true)
    expect(isAgentStateFileRoot(".claude")).toBe(false)
    expect(isAgentStateFileRoot(".local/share/opencode")).toBe(false)
  })

  it("declares every rule with a supported match kind", () => {
    for (const rule of AGENT_STATE_ROOT_RULES) {
      expect(["contains", "target", "base"]).toContain(rule.match)
      expect(rule.values.length).toBeGreaterThan(0)
      expect(rule.roots.length).toBeGreaterThan(0)
    }
  })
})
