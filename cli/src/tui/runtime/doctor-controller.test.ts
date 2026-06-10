import { buildDoctorReport, runDoctor, type DoctorFacts } from "./doctor-controller"
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
      listCredentialed: () => ["anthropic"],
      fileExists: () => true,
      modelCatalog: () => ["claude-opus-4-8", "claude-sonnet-4-6"],
      ...deps,
    }).then(() => actions)
  }

  it("emits a single notice assembled from the resolved config", async () => {
    const actions = await run({ provider: "anthropic", model: "claude-opus-4-8" })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
    if (actions[0].type === "NOTICE") {
      expect(actions[0].message).toContain("cognia-agent v9.9.9")
      expect(actions[0].message).toContain("claude-opus-4-8 ✓")
    }
  })

  it("marks a model outside the catalog as invalid", async () => {
    const actions = await run({ provider: "anthropic", model: "made-up-model" })
    if (actions[0].type === "NOTICE")
      expect(actions[0].message).toContain("✗ (not in this provider")
  })
})
