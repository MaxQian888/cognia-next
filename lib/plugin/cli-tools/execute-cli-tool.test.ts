import {
  executeCliTool,
  CliToolExecutionError,
  __setCliToolDepsForTesting,
  type CliToolDeps,
  type ExecuteCliToolContext,
} from "./execute-cli-tool"
import {
  evaluateCliBinary,
  configureCliBinaryPolicy,
  __resetCliBinaryPolicyForTesting,
} from "./cli-binary-policy"
import {
  confirmBinarySpawn,
  configureBinaryConsent,
  __resetBinaryConsentForTesting,
} from "@/lib/plugin/security/binary-consent"
import type { BinaryConsentOutcome } from "@/lib/plugin/security/binary-consent"
import type { PluginCliToolDef } from "@/types/plugin"
import type { ApprovedBinaryRow, AutomationAuditLogRow } from "@/lib/db/schema"

function makeDeps(overrides: Partial<CliToolDeps> = {}) {
  const audits: AutomationAuditLogRow[] = []
  const invocations: Array<Record<string, unknown>> = []
  const deps: CliToolDeps = {
    checkPermission: jest.fn(async () => true),
    requestBinaryConsent: jest.fn(async () => false),
    detect: jest.fn(async () => ({
      available: true,
      version: "ripgrep 14.1.0",
      path: "C:/bin/rg.exe",
      error: null,
    })),
    satisfiesMin: jest.fn(() => true),
    evaluatePluginDirBinary: jest.fn(async () => ({
      allowed: true,
      requiresPrompt: false,
      reason: "trusted",
    })),
    invokeExec: jest.fn(async (request) => {
      invocations.push(request)
      return {
        stdout: "line1\nline2\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }
    }),
    appendAudit: jest.fn(async (row) => {
      audits.push(row)
    }),
    getWorkspaceRoot: () => "C:/work/repo",
    now: () => 1000,
    ...overrides,
  }
  return { deps, audits, invocations }
}

const TOOL: PluginCliToolDef = {
  name: "ripgrep_search",
  description: "Search",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, globs: { type: "array" } },
  },
  binary: { kind: "requires", name: "rg" },
  argv: [
    { literal: "--json" },
    { param: "globs", eachPrefixedBy: "--glob", omitWhenEmpty: true },
    { param: "pattern" },
  ],
  outputParse: "lines",
  successExitCodes: [0, 1],
}

const CTX: ExecuteCliToolContext = {
  pluginPath: "C:/plugins/ripgrep-tools",
  requiresBinaries: [
    { name: "rg", minVersion: "13.0.0", documentation: "https://example.com/install-rg" },
  ],
}

afterEach(() => {
  __setCliToolDepsForTesting(null)
})

describe("executeCliTool", () => {
  it("runs the happy path: consent → resolve → argv → exec → parse → audit", async () => {
    const { deps, audits, invocations } = makeDeps()
    __setCliToolDepsForTesting(deps)

    const result = await executeCliTool(
      "ripgrep-tools",
      TOOL,
      { pattern: "needle", globs: ["*.ts"] },
      CTX
    )

    expect(result.output).toEqual(["line1", "line2"])
    expect(result.exitCode).toBe(0)
    expect(invocations[0]).toMatchObject({
      pluginId: "ripgrep-tools",
      toolName: "ripgrep_search",
      // detect_binary's absolute path wins over the bare name (PATH shadowing).
      program: "C:/bin/rg.exe",
      args: ["--json", "--glob", "*.ts", "needle"],
      stdin: null,
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ surface: "plugin", decision: "allow", error: null })
  })

  it("denies without cli:execute consent and never spawns", async () => {
    const { deps } = makeDeps({ checkPermission: jest.fn(async () => false) })
    __setCliToolDepsForTesting(deps)
    await expect(executeCliTool("p", TOOL, { pattern: "x" }, CTX)).rejects.toMatchObject({
      code: "permission-denied",
    })
    expect(deps.invokeExec).not.toHaveBeenCalled()
  })

  it("surfaces missing binaries with the install hint, without spawning", async () => {
    const { deps } = makeDeps({
      detect: jest.fn(async () => ({ available: false, version: null, path: null, error: "no" })),
    })
    __setCliToolDepsForTesting(deps)
    const error = await executeCliTool("p", TOOL, { pattern: "x" }, CTX).catch((e) => e)
    expect(error).toBeInstanceOf(CliToolExecutionError)
    expect(error.code).toBe("binary-missing")
    expect(error.message).toContain("https://example.com/install-rg")
    expect(deps.invokeExec).not.toHaveBeenCalled()
  })

  it("rejects binaries below the declared minVersion", async () => {
    const { deps } = makeDeps({ satisfiesMin: jest.fn(() => false) })
    __setCliToolDepsForTesting(deps)
    await expect(executeCliTool("p", TOOL, { pattern: "x" }, CTX)).rejects.toMatchObject({
      code: "binary-missing",
    })
  })

  it("plugin-dir binaries: trusted runs, untrusted prompts, denial blocks", async () => {
    const pluginDirTool: PluginCliToolDef = {
      ...TOOL,
      binary: { kind: "plugin-dir", relPath: "bin/tool.exe" },
    }
    // Untrusted + consent denied → blocked.
    const denied = makeDeps({
      evaluatePluginDirBinary: jest.fn(async () => ({
        allowed: false,
        requiresPrompt: true,
        reason: "untrusted",
      })),
      requestBinaryConsent: jest.fn(async () => false),
    })
    __setCliToolDepsForTesting(denied.deps)
    await expect(executeCliTool("p", pluginDirTool, { pattern: "x" }, CTX)).rejects.toMatchObject({
      code: "binary-untrusted",
    })
    expect(denied.deps.invokeExec).not.toHaveBeenCalled()

    // Untrusted + consent granted → runs with the joined plugin path.
    const granted = makeDeps({
      evaluatePluginDirBinary: jest.fn(async () => ({
        allowed: false,
        requiresPrompt: true,
        reason: "untrusted",
      })),
      requestBinaryConsent: jest.fn(async () => true),
    })
    __setCliToolDepsForTesting(granted.deps)
    await executeCliTool("p", pluginDirTool, { pattern: "x" }, CTX)
    expect(granted.invocations[0].program).toBe("C:/plugins/ripgrep-tools/bin/tool.exe")
  })

  it("maps template failures (missing param, bad stdin) to template errors", async () => {
    const { deps } = makeDeps()
    __setCliToolDepsForTesting(deps)
    await expect(executeCliTool("p", TOOL, {}, CTX)).rejects.toMatchObject({ code: "template" })

    const stdinTool: PluginCliToolDef = {
      ...TOOL,
      parameters: { type: "object", properties: { text: { type: "string" } } },
      argv: [],
      stdin: { param: "text" },
    }
    await expect(executeCliTool("p", stdinTool, { text: 42 as never }, CTX)).rejects.toMatchObject({
      code: "template",
    })

    // Valid stdin flows through to the exec request.
    await executeCliTool("p", stdinTool, { text: "piped" }, CTX)
    expect(deps.invokeExec).toHaveBeenCalledWith(expect.objectContaining({ stdin: "piped" }))
  })

  it("enforces exit-code policy with successExitCodes and stderr tail", async () => {
    const { deps } = makeDeps({
      invokeExec: jest.fn(async () => ({
        stdout: "",
        stderr: "fatal: boom",
        exitCode: 2,
        timedOut: false,
        truncated: false,
      })),
    })
    __setCliToolDepsForTesting(deps)
    const error = await executeCliTool("p", TOOL, { pattern: "x" }, CTX).catch((e) => e)
    expect(error.code).toBe("exit-code")
    expect(error.message).toContain("fatal: boom")

    // rg's "no match" exit 1 is success for this tool.
    const noMatch = makeDeps({
      invokeExec: jest.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
        truncated: false,
      })),
    })
    __setCliToolDepsForTesting(noMatch.deps)
    const result = await executeCliTool("p", TOOL, { pattern: "x" }, CTX)
    expect(result.output).toEqual([])
    expect(result.exitCode).toBe(1)
  })

  it("maps timeouts and spawn failures; failures still audit", async () => {
    const timedOut = makeDeps({
      invokeExec: jest.fn(async () => ({
        stdout: "",
        stderr: "command timed out after 100ms",
        exitCode: null,
        timedOut: true,
        truncated: false,
      })),
    })
    __setCliToolDepsForTesting(timedOut.deps)
    await expect(executeCliTool("p", TOOL, { pattern: "x" }, CTX)).rejects.toMatchObject({
      code: "timeout",
    })

    const spawnFail = makeDeps({
      invokeExec: jest.fn(async () => {
        throw new Error("spawn boom")
      }),
    })
    __setCliToolDepsForTesting(spawnFail.deps)
    await expect(executeCliTool("p", TOOL, { pattern: "x" }, CTX)).rejects.toMatchObject({
      code: "execution-failed",
    })
    expect(spawnFail.audits[0].error).toContain("spawn boom")
  })

  it("passes static env, cwd policy result, and knob passthrough", async () => {
    const { deps, invocations } = makeDeps()
    __setCliToolDepsForTesting(deps)
    const tool: PluginCliToolDef = {
      ...TOOL,
      env: { RIPGREP_CONFIG_PATH: "" },
      cwd: { kind: "workspace" },
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    }
    await executeCliTool("p", tool, { pattern: "x" }, CTX)
    expect(invocations[0]).toMatchObject({
      cwd: "C:/work/repo",
      env: { RIPGREP_CONFIG_PATH: "" },
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })
  })

  it("rejects non-object args", async () => {
    const { deps } = makeDeps()
    __setCliToolDepsForTesting(deps)
    await expect(
      executeCliTool("p", TOOL, null as unknown as Record<string, unknown>, CTX)
    ).rejects.toMatchObject({ code: "template" })
  })
})

// The ledger's allow-branch was dead code until the "remember this binary"
// checkbox landed: nothing wrote `approvedBinaries`, so `evaluateCliBinary`
// could never reach `allowed: true` and every plugin binary re-prompted on
// every spawn. These run the REAL policy against a fake ledger to prove the
// branch is now reachable — and that the hash pin still holds it shut.
describe("executeCliTool + approvedBinaries ledger (real policy)", () => {
  const PLUGIN_DIR_TOOL: PluginCliToolDef = {
    ...TOOL,
    binary: { kind: "plugin-dir", relPath: "bin/tool.exe" },
  }
  const BINARY_PATH = "C:/plugins/ripgrep-tools/bin/tool.exe"
  const APPROVED_HASH = "a".repeat(64)
  const CHANGED_HASH = "b".repeat(64)

  let ledger: ApprovedBinaryRow[]
  let hashes: Map<string, string | null>

  beforeEach(() => {
    ledger = []
    hashes = new Map([[BINARY_PATH, APPROVED_HASH]])
    configureCliBinaryPolicy({
      findApprovedBinary: async (pluginId, binaryPath) =>
        ledger.find((r) => r.pluginId === pluginId && r.binaryPath === binaryPath),
      hashBinary: async (binaryPath) => hashes.get(binaryPath) ?? null,
      appendAudit: async () => {},
      now: () => 1000,
    })
  })

  afterEach(() => {
    __resetCliBinaryPolicyForTesting()
    __resetBinaryConsentForTesting()
  })

  /** Deps wired to the real policy, with consent routed through the real writer. */
  function makeLedgerDeps(outcome: BinaryConsentOutcome) {
    const prompt = jest.fn(async (_input: Record<string, unknown>) => outcome)
    configureBinaryConsent({
      prompt,
      hashBinary: async (path: string) => hashes.get(path) ?? null,
      recordApproval: async (row) => {
        ledger.push({ ...row, approvedAt: 1000 })
        return row
      },
    })
    const { deps, invocations } = makeDeps({
      evaluatePluginDirBinary: evaluateCliBinary,
      requestBinaryConsent: (pluginId, reason, binary) =>
        confirmBinarySpawn({
          pluginId,
          permission: "cli:execute",
          binaryPath: binary.path,
          relPath: binary.relPath,
          reason,
        }),
    })
    return { deps, invocations, prompt }
  }

  it("remembered_binary_skips_the_prompt_on_next_spawn", async () => {
    // First spawn: no ledger row → prompt, user ticks "remember".
    const first = makeLedgerDeps({ granted: true, remember: true })
    __setCliToolDepsForTesting(first.deps)
    await executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    expect(first.prompt).toHaveBeenCalledTimes(1)
    expect(ledger).toEqual([
      {
        pluginId: "ripgrep-tools",
        binaryPath: BINARY_PATH,
        sha256: APPROVED_HASH,
        approvedAt: 1000,
      },
    ])

    // Second spawn: the row now hash-matches, so the policy allows silently.
    // This is the branch that was unreachable before the writer existed.
    const second = makeLedgerDeps({ granted: true, remember: true })
    __setCliToolDepsForTesting(second.deps)
    await executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    expect(second.prompt).not.toHaveBeenCalled()
    expect(second.invocations[0].program).toBe(BINARY_PATH)
  })

  it("binary_hash_change_reprompts_even_when_remembered", async () => {
    const first = makeLedgerDeps({ granted: true, remember: true })
    __setCliToolDepsForTesting(first.deps)
    await executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    expect(ledger).toHaveLength(1)

    // The bytes behind the approved path change — update, rebuild, or swap.
    // The approval is pinned to the hash, not the path, so it no longer
    // applies and the user must be asked again.
    hashes.set(BINARY_PATH, CHANGED_HASH)
    const second = makeLedgerDeps({ granted: false, remember: false })
    __setCliToolDepsForTesting(second.deps)
    await expect(
      executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    ).rejects.toMatchObject({ code: "binary-untrusted" })
    expect(second.prompt).toHaveBeenCalledTimes(1)
    expect(second.deps.invokeExec).not.toHaveBeenCalled()
  })

  it("session-only consent leaves the ledger empty and re-prompts next spawn", async () => {
    // The seam-level twin of binary-consent's regression guard: an unticked
    // prompt must not make the next spawn silent.
    const first = makeLedgerDeps({ granted: true, remember: false })
    __setCliToolDepsForTesting(first.deps)
    await executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    expect(ledger).toEqual([])

    const second = makeLedgerDeps({ granted: true, remember: false })
    __setCliToolDepsForTesting(second.deps)
    await executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    expect(second.prompt).toHaveBeenCalledTimes(1)
  })

  it("an unhashable binary re-prompts even with a matching ledger row", async () => {
    ledger.push({
      pluginId: "ripgrep-tools",
      binaryPath: BINARY_PATH,
      sha256: APPROVED_HASH,
      approvedAt: 1000,
    })
    hashes.set(BINARY_PATH, null)
    const { deps, prompt } = makeLedgerDeps({ granted: false, remember: false })
    __setCliToolDepsForTesting(deps)
    await expect(
      executeCliTool("ripgrep-tools", PLUGIN_DIR_TOOL, { pattern: "x" }, CTX)
    ).rejects.toMatchObject({ code: "binary-untrusted" })
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})
