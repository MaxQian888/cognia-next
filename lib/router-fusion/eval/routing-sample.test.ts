/**
 * routing-sample — the text-free feature encoding, the acceptance label, the
 * id derivations and the strict export / import door of the routing experiment.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  estimateTokens,
  fixtureFeatures,
  PHASES,
  TASK_KINDS,
  type RouteDecision,
  type RoutingFeatures,
} from "@cognia/router-fusion"

import type { FusionRoutingSampleRow } from "../db/types"
import {
  buildRoutingSampleExport,
  encodeRoutingFeatures,
  parseRoutingSampleExport,
  ROUTING_FEATURE_NAMES,
  ROUTING_FEATURES_VERSION,
  ROUTING_SAMPLE_EXPORT_SCHEMA,
  rulesPropensity,
  sampleAccepted,
  sampleIdFor,
  sampleSetLabel,
  shadowIdFor,
  toCostObservation,
  toTrainingSample,
} from "./routing-sample"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = 1_800_000_000_000

function column(name: string): number {
  const index = ROUTING_FEATURE_NAMES.indexOf(name)
  if (index < 0) throw new Error(`no feature column ${name}`)
  return index
}

function group(vector: readonly number[], prefix: string): number[] {
  return ROUTING_FEATURE_NAMES.flatMap((name, index) =>
    name.startsWith(`${prefix}:`) ? [vector[index]] : []
  )
}

function encode(overrides: Partial<RoutingFeatures> = {}): number[] {
  return encodeRoutingFeatures(fixtureFeatures(overrides))
}

function decision(selectedActionId: string | null): RouteDecision {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    decision_id: "22222222-2222-4222-8222-222222222222",
    run_id: "11111111-1111-4111-8111-111111111111",
    selected_action_id: selectedActionId,
    mode_selected: selectedActionId === null ? null : "direct",
    candidates: [],
    reason_codes: [],
    policy_version: "policy-1",
    registry_version: "registry-1",
    prompt_version: "prompt-1",
    classifier_version: "rules-1",
    degraded: false,
    created_at: "2026-09-15T08:00:00Z",
  }
}

function sampleRow(overrides: Partial<FusionRoutingSampleRow> = {}): FusionRoutingSampleRow {
  return {
    sampleId: "sample-b",
    runId: "run-b",
    groupId: "group-1",
    actionId: "direct_economy",
    actionHash: "hash-direct",
    mode: "direct",
    ruleId: "R2_economy_simple",
    baselineActionId: "direct_economy",
    featuresVersion: ROUTING_FEATURES_VERSION,
    features: encode(),
    propensity: 1,
    origin: "recorded",
    costMicrousd: 1_200,
    costStatus: "actual",
    accepted: true,
    qualityStatus: "accepted",
    runStatus: "succeeded",
    decidedAt: NOW - 60_000,
    createdAt: NOW - 30_000,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  }
}

describe("ROUTING_FEATURE_NAMES", () => {
  it("lays out every one-hot group and the scalar columns in a fixed, unique order", () => {
    expect(ROUTING_FEATURE_NAMES).toHaveLength(
      TASK_KINDS.length + PHASES.length + 4 + 5 + 5 + 3 + 6
    )
    expect(new Set(ROUTING_FEATURE_NAMES).size).toBe(ROUTING_FEATURE_NAMES.length)
    expect(ROUTING_FEATURE_NAMES[0]).toBe(`task:${TASK_KINDS[0]}`)
    expect(ROUTING_FEATURE_NAMES.slice(-6)).toEqual([
      "failed_attempts",
      "missing_information_count",
      "verification_kinds_count",
      "context_truncated",
      "has_source_revision",
      "goal_tokens_log1p",
    ])
    expect(ROUTING_FEATURE_NAMES.filter((name) => name.startsWith("language:"))).toEqual([
      "language:en",
      "language:zh",
      "language:und",
    ])
    expect(ROUTING_FEATURES_VERSION).toBe("router-fusion-features/1")
  })
})

describe("encodeRoutingFeatures", () => {
  it("one-hots each known label exactly once and encodes the scalars", () => {
    const vector = encode()
    expect(vector).toHaveLength(ROUTING_FEATURE_NAMES.length)
    for (const prefix of ["task", "phase", "ambiguity", "tool_need", "scope", "language"]) {
      expect(group(vector, prefix).reduce((sum, value) => sum + value, 0)).toBe(1)
    }
    expect(vector[column("task:qa.knowledge")]).toBe(1)
    expect(vector[column("phase:intake")]).toBe(1)
    expect(vector[column("ambiguity:low")]).toBe(1)
    expect(vector[column("tool_need:none")]).toBe(1)
    expect(vector[column("scope:single_item")]).toBe(1)
    expect(vector[column("language:en")]).toBe(1)
    expect(vector[column("failed_attempts")]).toBe(0)
    expect(vector[column("missing_information_count")]).toBe(0)
    expect(vector[column("verification_kinds_count")]).toBe(0)
    expect(vector[column("context_truncated")]).toBe(0)
    expect(vector[column("has_source_revision")]).toBe(0)
    expect(vector[column("goal_tokens_log1p")]).toBeCloseTo(
      Math.log1p(estimateTokens("fixture goal"))
    )
  })

  it("moves the hot bit with the label", () => {
    const vector = encode({
      task: "code.debug",
      phase: "review",
      ambiguity: "high",
      tool_need: "external_write",
      scope: "cross_system",
      language: "zh",
    })
    expect(vector[column("task:code.debug")]).toBe(1)
    expect(vector[column("task:qa.knowledge")]).toBe(0)
    expect(vector[column("phase:review")]).toBe(1)
    expect(vector[column("ambiguity:high")]).toBe(1)
    expect(vector[column("tool_need:external_write")]).toBe(1)
    expect(vector[column("scope:cross_system")]).toBe(1)
    expect(vector[column("language:zh")]).toBe(1)
    expect(vector[column("language:en")]).toBe(0)
  })

  it("matches the language case-insensitively", () => {
    expect(encode({ language: "ZH" })[column("language:zh")]).toBe(1)
    expect(encode({ language: "Und" })[column("language:und")]).toBe(1)
  })

  it("encodes an unrecognized label as all zeros in its group without changing the width", () => {
    const vector = encode({
      language: "fr",
      task: "future.task" as RoutingFeatures["task"],
      scope: "galactic" as RoutingFeatures["scope"],
    })
    expect(vector).toHaveLength(ROUTING_FEATURE_NAMES.length)
    expect(group(vector, "language").every((value) => value === 0)).toBe(true)
    expect(group(vector, "task").every((value) => value === 0)).toBe(true)
    expect(group(vector, "scope").every((value) => value === 0)).toBe(true)
    // The other groups are untouched.
    expect(vector[column("phase:intake")]).toBe(1)
  })

  it("clamps counts to [0, 10], floors fractions and zeroes non-finite values", () => {
    const at = (failed: number) => encode({ failed_attempts: failed })[column("failed_attempts")]
    expect(at(3)).toBe(3)
    expect(at(10)).toBe(10)
    expect(at(99)).toBe(10)
    expect(at(2.9)).toBe(2)
    expect(at(-4)).toBe(0)
    expect(at(Number.NaN)).toBe(0)
    expect(at(Number.POSITIVE_INFINITY)).toBe(0)

    const lists = encode({
      missing_information: Array.from({ length: 15 }, (_, index) => `gap-${index}`),
      verification_kinds: ["json_schema", "tests"],
    })
    expect(lists[column("missing_information_count")]).toBe(10)
    expect(lists[column("verification_kinds_count")]).toBe(2)
  })

  it("turns the truncation flag and the source revision into 0/1", () => {
    const flagged = encode({ context_truncated: true, source_revision: "rev-1" })
    expect(flagged[column("context_truncated")]).toBe(1)
    expect(flagged[column("has_source_revision")]).toBe(1)
    expect(encode({ source_revision: "" })[column("has_source_revision")]).toBe(0)
    expect(encode({ source_revision: null })[column("has_source_revision")]).toBe(0)
  })

  it("encodes the goal as the log1p of its token estimate and nothing else", () => {
    expect(encode({ goal: "" })[column("goal_tokens_log1p")]).toBe(0)
    expect(encode({ goal: "你好世界" })[column("goal_tokens_log1p")]).toBeCloseTo(Math.log1p(4))
    const long = "x".repeat(400)
    expect(encode({ goal: long })[column("goal_tokens_log1p")]).toBeCloseTo(Math.log1p(100))
    // Two different goals of the same estimated length are indistinguishable.
    expect(encode({ goal: "abcd efgh" })).toEqual(encode({ goal: "zzzz yyyy" }))
  })

  it("refuses to emit a vector whose width drifted from the declared names", () => {
    jest.isolateModules(() => {
      // A fresh registry: mutating this copy of TASK_KINDS cannot leak to other tests.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require("./routing-sample") as typeof import("./routing-sample")
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const contracts = require("@cognia/router-fusion") as typeof import("@cognia/router-fusion")
      ;(contracts.TASK_KINDS as unknown as string[]).push("drifted.task")
      expect(() => isolated.encodeRoutingFeatures(contracts.fixtureFeatures())).toThrow(
        `routing feature vector is ${ROUTING_FEATURE_NAMES.length + 1} wide, expected ${ROUTING_FEATURE_NAMES.length}`
      )
    })
  })
})

describe("rulesPropensity", () => {
  it("is 1 for the chosen action, 0 for any other and null when nothing was chosen", () => {
    expect(rulesPropensity(decision("direct_economy"), "direct_economy")).toBe(1)
    expect(rulesPropensity(decision("direct_economy"), "panel_review")).toBe(0)
    expect(rulesPropensity(decision(null), "direct_economy")).toBeNull()
  })
})

describe("sampleIdFor / shadowIdFor", () => {
  it("derives stable UUIDs per (run, decision) and per (sample, predictor)", () => {
    const sample = sampleIdFor("run-1", "decision-1")
    expect(sample).toMatch(UUID)
    expect(sampleIdFor("run-1", "decision-1")).toBe(sample)
    expect(sampleIdFor("run-2", "decision-1")).not.toBe(sample)
    expect(sampleIdFor("run-1", "decision-2")).not.toBe(sample)

    const shadow = shadowIdFor(sample, "sha-a")
    expect(shadow).toMatch(UUID)
    expect(shadowIdFor(sample, "sha-a")).toBe(shadow)
    expect(shadowIdFor(sample, "sha-b")).not.toBe(shadow)
    // The two derivations are namespaced apart.
    expect(shadowIdFor("run-1", "decision-1")).not.toBe(sampleIdFor("run-1", "decision-1"))
  })
})

describe("sampleAccepted", () => {
  it("accepts only a succeeded run whose result claimed accepted", () => {
    expect(sampleAccepted("succeeded", "accepted")).toBe(true)
    expect(sampleAccepted("succeeded", "degraded")).toBe(false)
    expect(sampleAccepted("succeeded", "unknown")).toBe(false)
    expect(sampleAccepted("succeeded", null)).toBe(false)
    for (const status of ["failed", "cancelled", "expired", "running"]) {
      expect(sampleAccepted(status, "accepted")).toBe(false)
    }
  })
})

describe("toTrainingSample / toCostObservation", () => {
  it("projects exactly the fields the trainer and the cost metric read", () => {
    const row = sampleRow({ accepted: false, costMicrousd: 4_321 })
    expect(toTrainingSample(row)).toEqual({
      sampleId: row.sampleId,
      groupId: row.groupId,
      timestamp: row.decidedAt,
      actionId: row.actionId,
      actionHash: row.actionHash,
      features: row.features,
      accepted: false,
    })
    expect(toCostObservation(row)).toEqual({ costMicrousd: 4_321, accepted: false })
  })
})

describe("sampleSetLabel", () => {
  it("labels an empty, a recorded and a simulated set", () => {
    expect(sampleSetLabel([])).toBeNull()
    expect(sampleSetLabel([sampleRow(), sampleRow({ sampleId: "other" })])).toBe("live")
    expect(sampleSetLabel([sampleRow({ origin: "simulated" })])).toBe("simulated")
  })

  it("refuses a set that mixes recorded and simulated rows", () => {
    expect(() => sampleSetLabel([sampleRow(), sampleRow({ origin: "simulated" })])).toThrow(
      /mixes recorded and simulated rows/
    )
  })
})

describe("buildRoutingSampleExport", () => {
  it("orders rows by sampleId, keeps propensity and leaves internal ids out", () => {
    const rows = [
      sampleRow({ sampleId: "sample-c", propensity: 1 / 3, accepted: false }),
      sampleRow({ sampleId: "sample-a", ruleId: null, qualityStatus: null }),
      sampleRow({ sampleId: "sample-b" }),
    ]
    const document = buildRoutingSampleExport(rows, { exportedAt: "2026-09-25T00:00:00Z" })
    expect(document.schema).toBe(ROUTING_SAMPLE_EXPORT_SCHEMA)
    expect(document.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
    expect(document.featureNames).toEqual([...ROUTING_FEATURE_NAMES])
    expect(document.featureNames).not.toBe(ROUTING_FEATURE_NAMES)
    expect(document.label).toBe("live")
    expect(document.exportedAt).toBe("2026-09-25T00:00:00Z")
    expect(document.sampleCount).toBe(3)
    expect(document.rows.map((row) => row.sampleId)).toEqual(["sample-a", "sample-b", "sample-c"])
    expect(document.rows[2].propensity).toBeCloseTo(1 / 3)
    expect(document.rows[0].ruleId).toBeNull()
    expect(document.rows[0].qualityStatus).toBeNull()
    for (const row of document.rows) {
      for (const internal of ["runId", "origin", "createdAt", "expiresAt", "featuresVersion"]) {
        expect(row).not.toHaveProperty(internal)
      }
    }
    // Feature vectors are copied, never shared with the stored rows.
    expect(document.rows[0].features).toEqual(rows[1].features)
    expect(document.rows[0].features).not.toBe(rows[1].features)
    // The caller's array is left in its original order.
    expect(rows.map((row) => row.sampleId)).toEqual(["sample-c", "sample-a", "sample-b"])
  })

  it("labels a simulated set simulated and an empty set simulated by default", () => {
    expect(
      buildRoutingSampleExport([sampleRow({ origin: "simulated" })], { exportedAt: "t" }).label
    ).toBe("simulated")
    const empty = buildRoutingSampleExport([], { exportedAt: "t" })
    expect(empty.label).toBe("simulated")
    expect(empty.sampleCount).toBe(0)
    expect(empty.rows).toEqual([])
    expect(empty.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
  })

  it("carries the rows' own feature version", () => {
    const document = buildRoutingSampleExport([sampleRow({ featuresVersion: "legacy/0" })], {
      exportedAt: "t",
    })
    expect(document.featuresVersion).toBe("legacy/0")
  })

  it("refuses rows that span feature versions or mix origins", () => {
    expect(() =>
      buildRoutingSampleExport(
        [sampleRow({ sampleId: "a", featuresVersion: "v/2" }), sampleRow({ sampleId: "b" })],
        { exportedAt: "t" }
      )
    ).toThrow(`spans feature versions ${ROUTING_FEATURES_VERSION}, v/2; train on one encoding`)
    expect(() =>
      buildRoutingSampleExport([sampleRow(), sampleRow({ origin: "simulated" })], {
        exportedAt: "t",
      })
    ).toThrow(/mixes recorded and simulated/)
  })
})

describe("parseRoutingSampleExport", () => {
  function validDocument(
    rows: FusionRoutingSampleRow[] = [sampleRow({ sampleId: "a" }), sampleRow({ sampleId: "b" })]
  ) {
    return JSON.parse(
      JSON.stringify(buildRoutingSampleExport(rows, { exportedAt: "2026-09-25T00:00:00Z" }))
    ) as Record<string, unknown> & { rows: Record<string, unknown>[] }
  }

  function withRow(patch: Record<string, unknown>, index = 1) {
    const document = validDocument()
    document.rows[index] = { ...document.rows[index], ...patch }
    return document
  }

  function withoutField(name: string, index = 1) {
    const document = validDocument()
    delete document.rows[index][name]
    return document
  }

  const parse = (value: unknown) => parseRoutingSampleExport(value, { now: NOW })

  it("round-trips an export into rows, re-keyed to the import time", () => {
    const original = [
      sampleRow({ sampleId: "a", propensity: 0.5, ruleId: null, qualityStatus: "degraded" }),
      sampleRow({ sampleId: "b", accepted: false, runStatus: "failed", qualityStatus: null }),
    ]
    const parsed = parseRoutingSampleExport(validDocument(original), {
      now: NOW,
      expiresAt: NOW + 5,
    })
    expect(parsed).toEqual(
      original.map((row) => ({
        ...row,
        runId: row.sampleId,
        origin: "recorded",
        createdAt: NOW,
        expiresAt: NOW + 5,
      }))
    )
  })

  it("marks the rows of a simulated export simulated and defaults expiry to now", () => {
    const parsed = parse(validDocument([sampleRow({ origin: "simulated" })]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].origin).toBe("simulated")
    expect(parsed[0].expiresAt).toBe(NOW)
    expect(parsed[0].createdAt).toBe(NOW)
  })

  it("accepts an empty row list", () => {
    expect(parse(validDocument([]))).toEqual([])
  })

  it("refuses a document that is not an export of this schema", () => {
    expect(() => parse(null)).toThrow("routing sample export must be an object")
    expect(() => parse("export")).toThrow("routing sample export must be an object")
    expect(() => parse({ ...validDocument(), schema: "other/v9" })).toThrow(
      `routing sample export schema must be ${ROUTING_SAMPLE_EXPORT_SCHEMA}, got other/v9`
    )
    expect(() => parse({ ...validDocument(), featuresVersion: "" })).toThrow(
      "routing sample export names no features version"
    )
    expect(() => parse({ ...validDocument(), featuresVersion: 1 })).toThrow(
      "routing sample export names no features version"
    )
    expect(() => parse({ ...validDocument(), label: "mixed" })).toThrow(
      "routing sample export label must be live or simulated, got mixed"
    )
    expect(() => parse({ ...validDocument(), rows: "none" })).toThrow(
      "routing sample export carries no rows"
    )
  })

  it("names the row that is not an object or lacks a field", () => {
    const notObject = validDocument()
    ;(notObject.rows as unknown[])[1] = 42
    expect(() => parse(notObject)).toThrow("routing sample 1 is not an object")
    expect(() => parse(withoutField("features"))).toThrow("routing sample 1 has no features")
    expect(() => parse(withoutField("sampleId"))).toThrow("routing sample 1 has no sampleId")
    expect(() => parse(withoutField("decidedAt"))).toThrow("routing sample 1 has no decidedAt")
  })

  it("checks the feature width against the document's own feature list", () => {
    const width = ROUTING_FEATURE_NAMES.length
    expect(() => parse(withRow({ features: [1, 2, 3] }))).toThrow(
      `routing sample 1: features must be ${width} numbers`
    )
    expect(() => parse(withRow({ features: "0,1" }))).toThrow(
      `routing sample 1: features must be ${width} numbers`
    )

    const narrow = validDocument([sampleRow({ features: [0, 1, 0.5] })])
    narrow.featureNames = ["a", "b", "c"]
    expect(parse(narrow)[0].features).toEqual([0, 1, 0.5])

    // With no feature list the host's width is the contract.
    const unnamed = validDocument()
    delete unnamed.featureNames
    expect(parse(unnamed)).toHaveLength(2)
  })

  it("refuses a non-finite feature value", () => {
    const features = encode()
    features[3] = Number.POSITIVE_INFINITY
    expect(() => parse(withRow({ features }))).toThrow(
      "routing sample 1: every feature must be a finite number"
    )
    const stringy: unknown[] = encode()
    stringy[0] = "1"
    expect(() => parse(withRow({ features: stringy }))).toThrow(
      "routing sample 1: every feature must be a finite number"
    )
  })

  it("keeps propensity inside (0, 1]", () => {
    expect(() => parse(withRow({ propensity: 0 }))).toThrow(
      "routing sample 1: propensity must be within (0, 1], got 0"
    )
    expect(() => parse(withRow({ propensity: 1.5 }))).toThrow(/within \(0, 1\], got 1.5/)
    expect(() => parse(withRow({ propensity: -0.2 }))).toThrow(/within \(0, 1\]/)
    expect(() => parse(withRow({ propensity: "1" }))).toThrow(
      "routing sample 1: propensity must be a finite number"
    )
    expect(parse(withRow({ propensity: 1 }))[1].propensity).toBe(1)
    expect(parse(withRow({ propensity: 0.25 }))[1].propensity).toBe(0.25)
  })

  it("requires a non-negative integer microusd cost", () => {
    expect(() => parse(withRow({ costMicrousd: -1 }))).toThrow(
      "routing sample 1: cost must be a non-negative integer microusd, got -1"
    )
    expect(() => parse(withRow({ costMicrousd: 1.5 }))).toThrow(/non-negative integer microusd/)
    expect(() => parse(withRow({ costMicrousd: 2 ** 53 }))).toThrow(/non-negative integer microusd/)
    expect(() => parse(withRow({ costMicrousd: null }))).toThrow(
      "routing sample 1: costMicrousd must be a finite number"
    )
    expect(parse(withRow({ costMicrousd: 0 }))[1].costMicrousd).toBe(0)
  })

  it("requires a boolean acceptance label", () => {
    expect(() => parse(withRow({ accepted: "yes" }))).toThrow(
      "routing sample 1: accepted must be a boolean"
    )
    expect(() => parse(withRow({ accepted: 1 }))).toThrow(/accepted must be a boolean/)
  })

  it("refuses unknown or empty enumerations", () => {
    expect(() => parse(withRow({ mode: "swarm" }))).toThrow("routing sample 1: unknown mode swarm")
    expect(() => parse(withRow({ mode: "" }))).toThrow(
      "routing sample 1: mode must be a non-empty string"
    )
    expect(() => parse(withRow({ mode: 3 }))).toThrow(
      "routing sample 1: mode must be a non-empty string"
    )
    expect(() => parse(withRow({ costStatus: "guessed" }))).toThrow(
      "routing sample 1: unknown cost status guessed"
    )
    expect(() => parse(withRow({ runStatus: "paused" }))).toThrow(
      "routing sample 1: unknown run status paused"
    )
    expect(() => parse(withRow({ qualityStatus: "excellent" }))).toThrow(
      "routing sample 1: unknown quality status excellent"
    )
    for (const mode of ["direct", "cascade", "panel", "delegate"]) {
      expect(parse(withRow({ mode }))[1].mode).toBe(mode)
    }
    for (const costStatus of ["actual", "estimated", "pending"]) {
      expect(parse(withRow({ costStatus }))[1].costStatus).toBe(costStatus)
    }
    for (const runStatus of ["queued", "waiting_for_approval", "cancelled", "expired"]) {
      expect(parse(withRow({ runStatus }))[1].runStatus).toBe(runStatus)
    }
  })

  it("normalizes an absent quality status and rule id to null", () => {
    const parsed = parse(withoutField("qualityStatus"))
    expect(parsed[1].qualityStatus).toBeNull()
    expect(parse(withoutField("ruleId"))[1].ruleId).toBeNull()
    expect(parse(withRow({ ruleId: null }))[1].ruleId).toBeNull()
    expect(parse(withRow({ ruleId: "R9" }))[1].ruleId).toBe("R9")
  })

  it("refuses a rule id that is neither a string nor null", () => {
    expect(() => parse(withRow({ ruleId: 7 }))).toThrow(
      "routing sample 1: ruleId must be a string or null"
    )
  })

  it("refuses empty identifiers and a non-numeric decision time", () => {
    for (const name of ["sampleId", "groupId", "actionId", "actionHash", "baselineActionId"]) {
      expect(() => parse(withRow({ [name]: "" }))).toThrow(
        `routing sample 1: ${name} must be a non-empty string`
      )
    }
    expect(() => parse(withRow({ decidedAt: "yesterday" }))).toThrow(
      "routing sample 1: decidedAt must be a finite number"
    )
  })

  it("names the first offending row, not a later one", () => {
    const document = validDocument()
    document.rows[0] = { ...document.rows[0], mode: "swarm" }
    document.rows[1] = { ...document.rows[1], costStatus: "guessed" }
    expect(() => parse(document)).toThrow("routing sample 0: unknown mode swarm")
  })
})
