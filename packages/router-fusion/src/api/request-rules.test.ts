import {
  decideIdempotency,
  idempotencyRequestHash,
  isVirtualRouterModel,
  parseChatCompatRequest,
  parseRunRequest,
  type RunRequestPolicy,
} from "./request-rules"

const POLICY: RunRequestPolicy = {
  trackedBudgetEnabled: true,
  maxRunCapMicrousd: (mode) => (mode === "delegate" ? 5_000_000 : 2_000_000),
  workspaceAuthorized: (id) => id === "66666666-6666-4666-8666-666666666666",
  acceptanceProfileExists: (id) => id === "tests",
  minimumProfile: "economy",
  degradeAllowed: false,
}

function runBody(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    input_messages: [{ role: "user", content: "compare A and B" }],
    mode: "panel",
    allowed_modes: ["panel"],
    profile: "balanced",
    budget: { max_cost_usd: "0.500000", mode: "strict" },
    deadline_ms: 120000,
    allow_degraded: false,
    delivery: "verified_buffered",
    ...overrides,
  }
}

describe("parseRunRequest", () => {
  it("accepts a valid panel request", () => {
    expect(parseRunRequest(runBody(), POLICY)).toMatchObject({ ok: true })
  })

  it("[ACC:API-05] refuses a mode outside allowed_modes instead of changing it", () => {
    const result = parseRunRequest(runBody({ mode: "panel", allowed_modes: ["direct"] }), POLICY)
    expect(result).toMatchObject({ ok: false, issues: [{ status: 422, code: "MODE_NOT_ALLOWED" }] })
  })

  it("[ACC:AUTH-06] refuses a forged tenant_id or scopes as unsupported fields", () => {
    const result = parseRunRequest(
      runBody({ tenant_id: "other", scopes: ["runs:approve"] }),
      POLICY
    )
    expect(result).toMatchObject({ ok: false, issues: [{ code: "UNSUPPORTED_PARAMETER" }] })
    if (!result.ok) expect(result.issues[0].details.fields).toEqual(["tenant_id", "scopes"])
  })

  it("requires an authorized workspace and an acceptance profile for delegate", () => {
    const result = parseRunRequest(
      runBody({ mode: "delegate", allowed_modes: ["delegate"] }),
      POLICY
    )
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual([
      "WORKSPACE_REQUIRED",
      "ACCEPTANCE_PROFILE_REQUIRED",
    ])
    const ok = parseRunRequest(
      runBody({
        mode: "delegate",
        allowed_modes: ["delegate"],
        workspace_id: "66666666-6666-4666-8666-666666666666",
        acceptance_profile_id: "tests",
      }),
      POLICY
    )
    expect(ok.ok).toBe(true)
    const foreignWorkspace = parseRunRequest(
      runBody({
        mode: "auto",
        allowed_modes: ["direct", "delegate"],
        workspace_id: "77777777-7777-4777-8777-777777777777",
      }),
      POLICY
    )
    expect(foreignWorkspace).toMatchObject({ ok: false, issues: [{ code: "WORKSPACE_REQUIRED" }] })
  })

  it("enforces budget mode, cap, profile minimum and degrade permission", () => {
    const result = parseRunRequest(
      runBody({
        budget: { max_cost_usd: "3.000000", mode: "tracked" },
        profile: "economy",
        allow_degraded: true,
      }),
      { ...POLICY, trackedBudgetEnabled: false, minimumProfile: "balanced" }
    )
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual([
      "PROFILE_BELOW_MINIMUM",
      "BUDGET_MODE_NOT_ENABLED",
      "BUDGET_ABOVE_LIMIT",
      "DEGRADE_NOT_PERMITTED",
    ])
  })

  it("reports schema failures by path", () => {
    const result = parseRunRequest(runBody({ deadline_ms: 10 }), POLICY)
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "SCHEMA_INVALID", details: { paths: ["deadline_ms"] } }],
    })
  })
})

describe("idempotency", () => {
  it("[ACC:API-02] detects the same key reused with a different body", () => {
    const scope = { actorKeyId: "key-1", endpoint: "POST /v1/runs" }
    const a = idempotencyRequestHash(scope, runBody())
    const reordered = idempotencyRequestHash(
      scope,
      Object.fromEntries(Object.entries(runBody()).reverse())
    )
    const spaced = idempotencyRequestHash(
      scope,
      runBody({ input_messages: [{ role: "user", content: "compare A  and B" }] })
    )
    expect(reordered).toBe(a)
    expect(spaced).not.toBe(a)
    expect(idempotencyRequestHash({ ...scope, actorKeyId: "key-2" }, runBody())).not.toBe(a)
    expect(decideIdempotency(undefined, a)).toEqual({ kind: "new" })
    expect(decideIdempotency({ requestHash: a, runId: "r" }, a)).toEqual({
      kind: "replay",
      runId: "r",
    })
    expect(decideIdempotency({ requestHash: a, runId: "r" }, spaced)).toEqual({ kind: "conflict" })
  })
})

describe("chat compat subset", () => {
  const base = {
    model: "cognia/panel",
    messages: [{ role: "user", content: "hello" }],
    routing: {
      profile: "balanced",
      budget: { max_cost_usd: "0.5", mode: "tracked" },
      deadline_ms: 60000,
      allow_degraded: false,
    },
  }

  it("maps cognia virtual models onto router models", () => {
    expect(parseChatCompatRequest(base)).toMatchObject({
      ok: true,
      value: { model: "router/panel" },
    })
    expect(isVirtualRouterModel("cognia/auto")).toBe(true)
    expect(isVirtualRouterModel("router/cascade")).toBe(true)
    expect(isVirtualRouterModel("gpt-4o")).toBe(false)
  })

  it("[ACC:API-04] refuses tools and n=2 with UNSUPPORTED_PARAMETER instead of ignoring them", () => {
    expect(parseChatCompatRequest({ ...base, tools: [{ type: "function" }] })).toMatchObject({
      ok: false,
      issues: [{ status: 422, code: "UNSUPPORTED_PARAMETER", details: { fields: ["tools"] } }],
    })
    expect(parseChatCompatRequest({ ...base, n: 2 })).toMatchObject({
      ok: false,
      issues: [{ code: "UNSUPPORTED_PARAMETER" }],
    })
    expect(parseChatCompatRequest({ ...base, temperature: 0.2, logprobs: true })).toMatchObject({
      ok: false,
      issues: [{ details: { fields: ["temperature", "logprobs"] } }],
    })
  })

  it("never offers delegate through chat completions", () => {
    expect(parseChatCompatRequest({ ...base, model: "cognia/delegate" })).toMatchObject({
      ok: false,
      issues: [{ code: "DELEGATE_REQUIRES_RUN_API" }],
    })
    expect(parseChatCompatRequest({ ...base, messages: [] })).toMatchObject({
      ok: false,
      issues: [{ code: "SCHEMA_INVALID" }],
    })
  })
})
