import os from "node:os"
import path from "node:path"

import {
  buildDoctorReport,
  collectDoctorReport,
  runDoctor,
  type DoctorFacts,
} from "./doctor-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

/**
 * Mirror `loadConfig`'s promotion: bind a top-level `model` to the active
 * provider's slot so `resolveActiveModel` (which the doctor now reads) returns
 * it, exactly as the real resolved config looks after a `--model` / persisted
 * pick. Without this, the catalog default would win in tests.
 */
function promoteActiveModel(config: ResolvedConfig): ResolvedConfig {
  if (!config.model) return config
  return {
    ...config,
    providers: {
      ...config.providers,
      [config.provider]: { ...config.providers[config.provider], model: config.model },
    },
  }
}

const facts: DoctorFacts = {
  version: "1.2.3",
  provider: "anthropic",
  model: "claude-opus-4-8",
  auth: "subscription",
  modelValid: true,
  credentialedProviders: ["anthropic", "deepseek"],
  cwd: "/work",
  dbSnapshotExists: true,
  dbSnapshotPath: "/home/.cognia/db.json",
  agentBackend: "builtin",
}

describe("buildDoctorReport", () => {
  it("renders every fact with check marks", () => {
    const r = buildDoctorReport(facts)
    expect(r).toContain("cognia-agent v1.2.3")
    expect(r).toContain("Model:        claude-opus-4-8 ✓")
    expect(r).toContain("Credentialed: anthropic, deepseek")
    expect(r).toContain("Local store:  ✓ /home/.cognia/db.json")
  })

  it("flags an invalid model and missing store", () => {
    const r = buildDoctorReport({
      ...facts,
      modelValid: false,
      dbSnapshotExists: false,
      credentialedProviders: [],
    })
    expect(r).toContain("✗ (not in this provider's catalog)")
    expect(r).toContain("Credentialed: none")
    expect(r).toMatch(/Local store:\s+✗/)
  })
})

describe("collectDoctorReport", () => {
  function collect(
    overrides: Partial<ResolvedConfig>,
    deps: Partial<Parameters<typeof collectDoctorReport>[0]> = {}
  ) {
    const config = promoteActiveModel({ ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", ...overrides })
    return collectDoctorReport({
      dispatch: () => undefined,
      config,
      home: "/home/.cognia",
      version: "9.9.9",
      os: { platform: () => "linux", homedir: () => "/home/x" },
      env: { XDG_DATA_HOME: "/data" },
      listCredentialed: () => ["anthropic"],
      fileExists: () => true,
      modelCatalog: () => ["claude-opus-4-8", "claude-sonnet-4-6"],
      crashLogFs: deps.crashLogFs,
      ...deps,
    })
  }

  it("assembles a DoctorReport with config and crash facts", () => {
    const report = collect({ provider: "anthropic", model: "claude-opus-4-8" })
    expect(report.version).toBe("9.9.9")
    expect(report.provider).toBe("anthropic")
    expect(report.model).toBe("claude-opus-4-8")
    expect(report.modelValid).toBe(true)
    expect(report.crashReportsDir).toMatch(/Cognia[\\/]crash-reports$/)
    expect(report.logsDir).toMatch(/Cognia[\\/]logs$/)
  })

  it("counts crash reports and surfaces the latest", () => {
    const crashLogFs = {
      readdirSync: () => [
        { name: "crash-2026-05-25_14-30-00-panic.txt", isDirectory: () => false },
        { name: "crash-2026-05-25_14-30-00-panic.json", isDirectory: () => false },
      ],
      readFileSync: (p: string) =>
        p.endsWith(".json") ? '{"capturedAt":"2026-05-25T14:30:00Z","kind":"panic"}' : "txt body",
      statSync: () => ({ size: 100 }),
    }
    const report = collect(
      { provider: "anthropic", model: "claude-opus-4-8" },
      { crashLogFs: crashLogFs as Parameters<typeof collectDoctorReport>[0]["crashLogFs"] }
    )
    expect(report.crashReportCount).toBe(1)
    expect(report.latestCrash?.stem).toBe("crash-2026-05-25_14-30-00-panic")
    expect(report.latestCrash?.kind).toBe("panic")
  })

  it("marks a model outside the catalog as invalid", () => {
    const report = collect({ provider: "anthropic", model: "made-up-model" })
    expect(report.modelValid).toBe(false)
  })
})

describe("runDoctor", () => {
  function run(
    overrides: Partial<ResolvedConfig>,
    deps: Partial<Parameters<typeof runDoctor>[0]> = {}
  ) {
    const actions: TuiAction[] = []
    const config = promoteActiveModel({ ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", ...overrides })
    return runDoctor({
      dispatch: (a) => actions.push(a),
      config,
      home: "/home/.cognia",
      version: "9.9.9",
      os: { platform: os.platform, homedir: os.homedir },
      env: process.env,
      listCredentialed: () => ["anthropic"],
      fileExists: () => true,
      modelCatalog: () => ["claude-opus-4-8", "claude-sonnet-4-6"],
      ...deps,
    }).then(() => actions)
  }

  it("opens the doctor overlay", async () => {
    const actions = await run({ provider: "anthropic", model: "claude-opus-4-8" })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: "OVERLAY_OPEN" })
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.version).toBe("9.9.9")
      expect(actions[0].overlay.report.model).toBe("claude-opus-4-8")
    }
  })

  it("reports whether the configured external backend command is available", async () => {
    const checkExternalCommand = jest.fn(async (command: string) => command === "npx")
    const actions = await run({ agentBackend: "claude-code" }, { checkExternalCommand })
    expect(checkExternalCommand).toHaveBeenCalledWith("npx")
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report).toMatchObject({
        agentBackend: "claude-code",
        externalAgentCommand: "npx",
        externalAgentAvailable: true,
        externalAgentHooksActive: false,
        externalAgentTerminalActive: false,
      })
    }
  })

  it("reports sandbox readiness, not just whether the command is on PATH", async () => {
    // The command resolving says nothing about whether we can sandbox it, and
    // without the launcher every turn fails to spawn.
    const actions = await run(
      { agentBackend: "claude-code" },
      {
        checkExternalCommand: async () => true,
        findLauncher: () => undefined,
        platformSupportsSandbox: () => true,
      }
    )
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report).toMatchObject({
        externalAgentAvailable: true,
        externalAgentSandboxReady: false,
        externalAgentPlatformSupported: true,
      })
    }
  })

  it("flags a platform that cannot host external agents at all", async () => {
    const actions = await run(
      { agentBackend: "claude-code" },
      {
        checkExternalCommand: async () => true,
        findLauncher: () => "/opt/launcher",
        platformSupportsSandbox: () => false,
      }
    )
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.externalAgentPlatformSupported).toBe(false)
    }
  })

  it("resolves the preferred codex executable preset before probing", async () => {
    const checkExternalCommand = jest.fn(async () => true)
    const actions = await run(
      { agentBackend: "codex" },
      { checkExternalCommand, findLauncher: () => "/opt/launcher" }
    )
    expect(checkExternalCommand).toHaveBeenCalledWith(expect.any(String))
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.agentBackend).toBe("codex")
      expect(actions[0].overlay.report.externalAgentCommand).toEqual(expect.any(String))
    }
  })

  it("reports a preset with no launchable command as unavailable", async () => {
    const checkExternalCommand = jest.fn(async () => true)
    const actions = await run({ agentBackend: "not-a-preset" }, { checkExternalCommand })
    expect(checkExternalCommand).not.toHaveBeenCalled()
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.externalAgentAvailable).toBe(false)
    }
  })

  it("probes the real launcher + platform when no override is injected", async () => {
    const actions = await run(
      { agentBackend: "claude-code" },
      { checkExternalCommand: async () => true }
    )
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(typeof actions[0].overlay.report.externalAgentSandboxReady).toBe("boolean")
      expect(typeof actions[0].overlay.report.externalAgentPlatformSupported).toBe("boolean")
    }
  })

  it("degrades gracefully where no crash/log directory can be resolved", async () => {
    const actions = await run(
      {},
      { os: { platform: () => "freebsd" as NodeJS.Platform, homedir: os.homedir } }
    )
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.crashReportCount).toBe(0)
      expect(actions[0].overlay.report.logDirBytes).toBe(0)
    }
  })

  it("works off its real defaults when nothing is injected", async () => {
    // Exercises the production credential/catalog/fs/command readers rather than
    // the test doubles every other case supplies.
    const actions: TuiAction[] = []
    await runDoctor({
      dispatch: (a) => actions.push(a),
      config: promoteActiveModel({
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/work",
        agentBackend: "claude-code",
      }),
      home: path.join(os.tmpdir(), "cognia-doctor-absent"),
      version: "9.9.9",
      os: { platform: os.platform, homedir: os.homedir },
      env: process.env,
    })
    expect(actions).toHaveLength(1)
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.dbSnapshotExists).toBe(false)
      expect(actions[0].overlay.report.credentialedProviders).toEqual([])
    }
  })

  it("leaves sandbox facts absent on the built-in backend", async () => {
    const actions = await run({ agentBackend: "builtin" })
    if (actions[0].type === "OVERLAY_OPEN" && actions[0].overlay.kind === "doctor") {
      expect(actions[0].overlay.report.externalAgentSandboxReady).toBeUndefined()
    }
  })
})
