import os from "node:os"

import {
  buildDoctorReport,
  collectDoctorReport,
  runDoctor,
  type DoctorFacts,
  type DoctorReportDeps,
} from "./doctor-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

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
    const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", ...overrides }
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
    const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", ...overrides }
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
})
