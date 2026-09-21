/**
 * The live smoke's cases (ADR-0188 D4/D20, B5 WP-E3).
 *
 * One case per execution mode, each small enough that a real provider answers
 * it for cents, and each run through the real engine: the ActionRouter picks
 * the action and pins its roles, the ledger reserves and settles every call,
 * the orchestrator seals the run. The harness never picks a model itself.
 *
 * The same cases run against the Fake Provider (`--fake`), so the offline
 * path proves the harness end to end without a byte leaving the machine.
 *
 * Delegate needs a workspace; its case carries a tiny fixture repository the
 * host writes into a temp directory. Whether this build can run delegate at
 * all is the ROUTER's answer (its capability exclusions), never a flag here:
 * `classifyRouteRefusal` reads the decision the router made.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  RunRequestSchema,
  type ExecutionMode,
  type Message,
  type RouteDecision,
  type RunRequest,
} from "../contracts/schemas"
import { microusdToUsd, type Microusd } from "../money/microusd"

export const LIVE_SMOKE_CASE_IDS = ["direct", "cascade", "panel", "delegate"] as const
export type LiveSmokeCaseId = (typeof LIVE_SMOKE_CASE_IDS)[number]

export interface LiveSmokeCase {
  id: LiveSmokeCaseId
  mode: ExecutionMode
  title: string
  /** What a pass of this case demonstrates. */
  purpose: string
  /** The caller's turns. The Run API only accepts user turns as input. */
  messages: Message[]
  /** Structured output the case asks for, or null for free text. */
  jsonSchema: Record<string, unknown> | null
  /** The request accepts an explicitly labelled degraded result (spec `allow_degraded`). */
  allowDegraded: boolean
  profile: "economy" | "balanced" | "quality"
  deadlineMs: number
  /** The case's own cap. The account's per-mode run cap can only lower it (D22). */
  capUsd: string
  /** The case runs against the fixture repository the host creates in a temp dir. */
  usesFixtureRepo: boolean
}

/** The structured answer the cascade case asks for. */
export const CASCADE_CASE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["country", "capital"],
  properties: {
    country: { type: "string" },
    capital: { type: "string" },
  },
  additionalProperties: false,
}

/** The acceptance profile the fixture repository declares (`.cognia/workspace.json`). */
export const FIXTURE_ACCEPTANCE_PROFILE_ID = "smoke"

/**
 * The tiny fixture repository for the delegate case: one module with one bug,
 * the tests that catch it, and the acceptance profile that runs them (the
 * `acceptanceProfiles` shape of ADR-0188 D15: a command plus a JUnit report).
 * It only uses Node's own test runner, so the acceptance run needs no install.
 */
export const DELEGATE_FIXTURE_FILES: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "cognia-live-smoke-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test test/slugify.test.mjs" },
    },
    null,
    2
  )}\n`,
  "src/slugify.mjs": [
    "// Turns a title into a URL slug: lowercase words joined by single dashes.",
    "export function slugify(text) {",
    '  return text.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")',
    "}",
    "",
  ].join("\n"),
  "test/slugify.test.mjs": [
    'import assert from "node:assert/strict"',
    'import { test } from "node:test"',
    "",
    'import { slugify } from "../src/slugify.mjs"',
    "",
    'test("lowercases words", () => {',
    '  assert.equal(slugify("Hello World"), "hello-world")',
    "})",
    "",
    'test("collapses separators", () => {',
    '  assert.equal(slugify("  a -- b  "), "a-b")',
    "})",
    "",
  ].join("\n"),
  ".cognia/workspace.json": `${JSON.stringify(
    {
      version: 1,
      acceptanceProfiles: {
        [FIXTURE_ACCEPTANCE_PROFILE_ID]: {
          command: [
            "node",
            "--test",
            "--test-reporter=junit",
            "--test-reporter-destination=junit.xml",
            "test/slugify.test.mjs",
          ],
          report: { format: "junit", path: "junit.xml" },
          requiredTests: ["lowercases words", "collapses separators"],
          timeoutMs: 60_000,
        },
      },
    },
    null,
    2
  )}\n`,
}

export const LIVE_SMOKE_CASES: readonly LiveSmokeCase[] = [
  {
    id: "direct",
    mode: "direct",
    title: "Direct: one short answer",
    purpose: "one solver call, streamed usage and request id settled by the ledger",
    messages: [{ role: "user", content: "In one sentence, explain what a unit test is." }],
    jsonSchema: null,
    allowDegraded: false,
    profile: "balanced",
    deadlineMs: 120_000,
    capUsd: "0.40",
    usesFixtureRepo: false,
  },
  {
    id: "cascade",
    mode: "cascade",
    title: "Cascade: schema-checked JSON",
    purpose:
      "the cheap stage answers a schema-checked question; the strong stage runs only if it fails",
    messages: [
      {
        role: "user",
        content:
          'Which city is the capital of France? Answer as JSON with the fields "country" and "capital".',
      },
    ],
    jsonSchema: CASCADE_CASE_SCHEMA,
    allowDegraded: false,
    profile: "balanced",
    deadlineMs: 120_000,
    capUsd: "0.80",
    usesFixtureRepo: false,
  },
  {
    id: "panel",
    mode: "panel",
    title: "Panel: two candidates, judge, synthesis",
    purpose:
      "independent candidates, an anonymous judge, a synthesis and its final check; with no evidence tool on this host the result is an explicitly labelled degraded one",
    messages: [
      {
        role: "user",
        content: "Give two practical benefits of code review, one short sentence each.",
      },
    ],
    jsonSchema: null,
    // This host offers panel members no read tools, so no claim can carry
    // evidence of its own and `evidence_review` cannot pass. The request says
    // up front that a labelled degraded result is acceptable; it is reported
    // as degraded, never as an accepted fusion answer.
    allowDegraded: true,
    profile: "balanced",
    deadlineMs: 120_000,
    capUsd: "1.60",
    usesFixtureRepo: false,
  },
  {
    id: "delegate",
    mode: "delegate",
    title: "Delegate: fix the fixture repository",
    purpose:
      "a lead plans, a worker patches, the acceptance profile verifies the patch in a sandbox",
    messages: [
      {
        role: "user",
        content: `The acceptance profile "${FIXTURE_ACCEPTANCE_PROFILE_ID}" fails because slugify in src/slugify.mjs keeps uppercase letters. Fix src/slugify.mjs so every test passes, and change nothing else.`,
      },
    ],
    jsonSchema: null,
    allowDegraded: false,
    profile: "balanced",
    deadlineMs: 900_000,
    capUsd: "2.00",
    usesFixtureRepo: true,
  },
]

export interface CaseRequestOptions {
  capMicrousd: Microusd
  budgetMode: "strict" | "tracked"
  /** The Run API's name for the fixture workspace; only a fixture case carries it. */
  workspaceId?: string
}

/**
 * The contract `RunRequest` for a case, validated by the contract's own
 * schema. An explicit mode, and only that mode allowed: the case asks the
 * router for exactly one kind of work.
 */
export function caseRunRequest(definition: LiveSmokeCase, options: CaseRequestOptions): RunRequest {
  return RunRequestSchema.parse({
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: definition.messages.map((message) => ({
      role: "user",
      content: message.content,
    })),
    mode: definition.mode,
    allowed_modes: [definition.mode],
    profile: definition.profile,
    budget: { max_cost_usd: microusdToUsd(options.capMicrousd), mode: options.budgetMode },
    deadline_ms: definition.deadlineMs,
    ...(definition.usesFixtureRepo && options.workspaceId
      ? { workspace_id: options.workspaceId, acceptance_profile_id: FIXTURE_ACCEPTANCE_PROFILE_ID }
      : {}),
    allow_degraded: definition.allowDegraded,
    delivery: "verified_buffered",
  })
}

/**
 * Router exclusions that say the host cannot run a mode at all, whatever the
 * request: no sandbox tier, no verifier for the mode's acceptance profile, or
 * a mode the build does not offer. Any other exclusion (budget, deadline, a
 * role no deployment can fill) is a refusal of this request.
 */
export const MODE_UNAVAILABLE_EXCLUSIONS: readonly string[] = [
  "SANDBOX_UNAVAILABLE",
  "VERIFIER_UNAVAILABLE",
  "MODE_NOT_ALLOWED",
]

export type RouteRefusalClass =
  | { kind: "skipped"; detail: string; reasons: string[] }
  | { kind: "refused"; detail: string; reasons: string[] }

/**
 * What a refused route means for a case, read from the router's own decision.
 *
 * A case requests one explicit mode, so every action of another mode is
 * excluded as `MODE_NOT_REQUESTED`; the rest are the requested mode's own
 * candidates. When every one of them carries a mode-unavailable exclusion, the
 * case is skipped: this build cannot run the mode. Otherwise the router
 * refused this request (budget, deadline, deployments), which is a finding,
 * not a skip. No candidate at all (an action whose role aliases resolve to
 * nothing is left out of the snapshot) is a refusal with the router's reasons.
 */
export function classifyRouteRefusal(
  mode: ExecutionMode,
  refusal: { reasons: readonly string[]; decision: RouteDecision | null }
): RouteRefusalClass {
  const requested = (refusal.decision?.candidates ?? []).filter(
    (candidate) => !candidate.exclusion_reasons.includes("MODE_NOT_REQUESTED")
  )
  const routerReasons = requested.flatMap((candidate) =>
    candidate.exclusion_reasons.map((reason) => `${candidate.action_id}:${reason}`)
  )
  const reasons = [...new Set([...routerReasons, ...refusal.reasons])]
  const unavailable =
    requested.length > 0 &&
    requested.every((candidate) =>
      candidate.exclusion_reasons.some((reason) => MODE_UNAVAILABLE_EXCLUSIONS.includes(reason))
    )
  if (unavailable) {
    return { kind: "skipped", detail: `skipped: ${mode} not available in this build`, reasons }
  }
  return { kind: "refused", detail: `refused: the router found no ${mode} action`, reasons }
}
