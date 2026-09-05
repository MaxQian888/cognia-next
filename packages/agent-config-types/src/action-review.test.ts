import {
  ACTION_REVIEW_AUTHORITIES,
  ACTION_REVIEW_CHANNELS,
  ACTION_REVIEW_CONTRACT_VERSION,
  ACTION_REVIEW_OUTCOMES,
  ACTION_REVIEW_SURFACE_IDS,
  ACTION_REVIEW_TIERS,
  ACTION_REVIEW_VERDICTS,
  isActionReviewDecision,
  isActionReviewReceipt,
  isActionReviewRequest,
  permitsExecution,
  validateActionReviewDecision,
  validateActionReviewReceipt,
  validateActionReviewRequest,
  type ActionReviewDecision,
  type ActionReviewReceipt,
  type ActionReviewRequest,
} from "./action-review"

function makeRequest(overrides: Partial<ActionReviewRequest> = {}): ActionReviewRequest {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: "req-1",
    origin: { channel: "chat-tool", scope: "chat", id: "req-1" },
    subject: { kind: "tool-call", ref: "Bash" },
    verdict: "ask",
    verdictExplicit: false,
    tier: "medium",
    surfaces: [{ id: "native-command", evidence: "bash" }],
    requestedAt: 1_000,
    ...overrides,
  }
}

function makeDecision(overrides: Partial<ActionReviewDecision> = {}): ActionReviewDecision {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: "req-1",
    outcome: "allow",
    authority: "human",
    decidedAt: 2_000,
    ...overrides,
  }
}

function makeReceipt(overrides: Partial<ActionReviewReceipt> = {}): ActionReviewReceipt {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    id: "req-1",
    request: makeRequest(),
    decision: makeDecision(),
    expiresAt: 90_000,
    ...overrides,
  }
}

describe("vocabulary constants", () => {
  it("exposes every member of each closed union", () => {
    expect(ACTION_REVIEW_VERDICTS).toEqual(["allow", "ask", "deny"])
    expect(ACTION_REVIEW_TIERS).toEqual(["low", "medium", "high"])
    expect(ACTION_REVIEW_SURFACE_IDS).toHaveLength(6)
    expect(ACTION_REVIEW_CHANNELS).toHaveLength(15)
    expect(ACTION_REVIEW_OUTCOMES).toHaveLength(5)
  })

  it("has no `model` authority — a model may recommend, never authorize", () => {
    expect(ACTION_REVIEW_AUTHORITIES).not.toContain("model")
    expect(ACTION_REVIEW_AUTHORITIES).toEqual([
      "human",
      "policy-rule",
      "policy-default",
      "policy-deny",
      "timeout",
      "system",
    ])
  })
})

describe("validateActionReviewRequest", () => {
  it("accepts a well-formed request", () => {
    expect(validateActionReviewRequest(makeRequest())).toEqual([])
    expect(isActionReviewRequest(makeRequest())).toBe(true)
  })

  it.each([null, undefined, "x", 1, []])("rejects non-object %p", (value) => {
    expect(validateActionReviewRequest(value)).toEqual(["request must be an object"])
  })

  it("rejects a wrong contract version", () => {
    expect(validateActionReviewRequest(makeRequest({ contractVersion: 2 as never }))).toContain(
      "contractVersion must be 1"
    )
  })

  it("rejects a missing requestId", () => {
    expect(validateActionReviewRequest(makeRequest({ requestId: "" }))).toContain(
      "requestId is required"
    )
  })

  it("rejects a missing origin", () => {
    expect(validateActionReviewRequest(makeRequest({ origin: undefined as never }))).toContain(
      "origin is required"
    )
  })

  it("rejects an unknown channel", () => {
    const req = makeRequest({ origin: { channel: "nope" as never, scope: "s", id: "i" } })
    expect(validateActionReviewRequest(req)).toContain(
      "origin.channel must be a known ActionReviewChannel"
    )
  })

  it("rejects a missing origin scope and id", () => {
    const req = makeRequest({ origin: { channel: "generic", scope: "", id: "" } })
    const errors = validateActionReviewRequest(req)
    expect(errors).toContain("origin.scope is required")
    expect(errors).toContain("origin.id is required")
  })

  it.each([
    ["https://host/x", "URL-shaped value in a ref position"],
    ["token=abc", "secret-shaped value in a ref position"],
  ])("rejects an unsafe hostRef %p", (hostRef, expected) => {
    const req = makeRequest({ origin: { channel: "generic", scope: "s", id: "i", hostRef } })
    expect(validateActionReviewRequest(req)).toContain(`origin.hostRef: ${expected}`)
  })

  it("rejects an empty hostRef", () => {
    const req = makeRequest({ origin: { channel: "generic", scope: "s", id: "i", hostRef: "" } })
    expect(validateActionReviewRequest(req)).toContain("origin.hostRef must be a non-empty string")
  })

  it("accepts a safe hostRef", () => {
    const req = makeRequest({
      origin: { channel: "generic", scope: "s", id: "i", hostRef: "host-abc" },
    })
    expect(validateActionReviewRequest(req)).toEqual([])
  })

  it("rejects a missing subject", () => {
    expect(validateActionReviewRequest(makeRequest({ subject: undefined as never }))).toContain(
      "subject is required"
    )
  })

  it("rejects an unknown subject kind and empty ref", () => {
    const req = makeRequest({ subject: { kind: "nope" as never, ref: "" } })
    const errors = validateActionReviewRequest(req)
    expect(errors).toContain("subject.kind must be a known ActionReviewSubjectKind")
    expect(errors).toContain("subject.ref is required")
  })

  it("rejects a non-object subject input", () => {
    const req = makeRequest({ subject: { kind: "tool-call", ref: "Bash", input: [] as never } })
    expect(validateActionReviewRequest(req)).toContain("subject.input must be an object")
  })

  it("rejects a non-array surfaces", () => {
    expect(validateActionReviewRequest(makeRequest({ surfaces: {} as never }))).toContain(
      "surfaces must be an array"
    )
  })

  it("rejects a non-object surface entry", () => {
    expect(validateActionReviewRequest(makeRequest({ surfaces: ["x" as never] }))).toContain(
      "surfaces[0] must be an object"
    )
  })

  it("rejects an unknown surface id and empty evidence", () => {
    const req = makeRequest({ surfaces: [{ id: "nope" as never, evidence: "" }] })
    const errors = validateActionReviewRequest(req)
    expect(errors).toContain("surfaces[0].id must be a known ActionReviewSurfaceId")
    expect(errors).toContain("surfaces[0].evidence is required")
  })

  it.each([
    ["verdict", { verdict: "nope" as never }, "verdict must be allow, ask, or deny"],
    ["verdictExplicit", { verdictExplicit: "yes" as never }, "verdictExplicit must be a boolean"],
    ["tier", { tier: "nope" as never }, "tier must be low, medium, or high"],
    ["requestedAt", { requestedAt: Number.NaN }, "requestedAt must be a finite number"],
    ["expiresAt", { expiresAt: Number.POSITIVE_INFINITY }, "expiresAt must be a finite number"],
  ])("rejects a bad %s", (_label, overrides, expected) => {
    expect(validateActionReviewRequest(makeRequest(overrides))).toContain(expected)
  })

  describe("recommendation", () => {
    it("accepts a well-formed recommendation", () => {
      const req = makeRequest({
        recommendation: { suggests: "allow", source: "command-judge", confidence: "high" },
      })
      expect(validateActionReviewRequest(req)).toEqual([])
    })

    it("rejects a non-object recommendation", () => {
      expect(validateActionReviewRequest(makeRequest({ recommendation: 1 as never }))).toContain(
        "recommendation must be an object"
      )
    })

    it("rejects a bad suggests, source, and confidence", () => {
      const req = makeRequest({
        recommendation: { suggests: "maybe" as never, source: "", confidence: "certain" as never },
      })
      const errors = validateActionReviewRequest(req)
      expect(errors).toContain('recommendation.suggests must be "allow" or "deny"')
      expect(errors).toContain("recommendation.source is required")
      expect(errors).toContain("recommendation.confidence must be low, medium, or high")
    })
  })
})

describe("validateActionReviewDecision", () => {
  it("accepts a well-formed decision", () => {
    expect(validateActionReviewDecision(makeDecision())).toEqual([])
    expect(isActionReviewDecision(makeDecision())).toBe(true)
  })

  it("rejects a non-object", () => {
    expect(validateActionReviewDecision(null)).toEqual(["decision must be an object"])
  })

  it.each([
    ["contractVersion", { contractVersion: 0 as never }, "contractVersion must be 1"],
    ["requestId", { requestId: "" }, "requestId is required"],
    ["outcome", { outcome: "maybe" as never }, "outcome must be a known ActionReviewOutcome"],
    ["decidedAt", { decidedAt: "now" as never }, "decidedAt must be a finite number"],
  ])("rejects a bad %s", (_label, overrides, expected) => {
    expect(validateActionReviewDecision(makeDecision(overrides))).toContain(expected)
  })

  // The load-bearing rule of this contract.
  it.each(["model", "auto", "agent", "llm", ""])(
    "rejects the invented authority %p",
    (authority) => {
      expect(
        validateActionReviewDecision(makeDecision({ authority: authority as never }))
      ).toContain("authority must be a known ActionReviewAuthority")
    }
  )

  it.each(ACTION_REVIEW_AUTHORITIES.filter((a) => a !== "timeout"))(
    "accepts the known authority %p",
    (authority) => {
      expect(validateActionReviewDecision(makeDecision({ authority }))).toEqual([])
    }
  )

  it("rejects a timeout that permits execution — a backstop is never a grant", () => {
    for (const outcome of ["allow", "allow_always"] as const) {
      expect(
        validateActionReviewDecision(makeDecision({ authority: "timeout", outcome }))
      ).toContain('authority "timeout" cannot permit execution')
    }
  })

  it("accepts a timeout that denies", () => {
    expect(
      validateActionReviewDecision(makeDecision({ authority: "timeout", outcome: "expired" }))
    ).toEqual([])
  })

  it("rejects a non-object updatedInput", () => {
    expect(validateActionReviewDecision(makeDecision({ updatedInput: [] as never }))).toContain(
      "updatedInput must be an object"
    )
  })

  describe("derivedRule", () => {
    it("accepts a well-formed rule", () => {
      const decision = makeDecision({
        outcome: "allow_always",
        derivedRule: { tool: "Bash", pattern: "git *" },
      })
      expect(validateActionReviewDecision(decision)).toEqual([])
    })

    it("rejects a non-object rule", () => {
      expect(validateActionReviewDecision(makeDecision({ derivedRule: 1 as never }))).toContain(
        "derivedRule must be an object"
      )
    })

    it("rejects an incomplete rule", () => {
      const decision = makeDecision({ derivedRule: { tool: "", pattern: "" } })
      const errors = validateActionReviewDecision(decision)
      expect(errors).toContain("derivedRule.tool is required")
      expect(errors).toContain("derivedRule.pattern is required")
    })
  })

  describe("actor", () => {
    it("accepts a well-formed actor", () => {
      const decision = makeDecision({ actor: { kind: "local-user", id: "u1", label: "Me" } })
      expect(validateActionReviewDecision(decision)).toEqual([])
    })

    it("rejects a non-object actor", () => {
      expect(validateActionReviewDecision(makeDecision({ actor: "me" as never }))).toContain(
        "actor must be an object"
      )
    })

    it("rejects an unknown actor kind", () => {
      expect(
        validateActionReviewDecision(makeDecision({ actor: { kind: "robot" as never } }))
      ).toContain("actor.kind must be a known ActionReviewActorKind")
    })
  })
})

describe("validateActionReviewReceipt", () => {
  it("accepts a well-formed receipt", () => {
    expect(validateActionReviewReceipt(makeReceipt())).toEqual([])
    expect(isActionReviewReceipt(makeReceipt())).toBe(true)
  })

  it("rejects a non-object", () => {
    expect(validateActionReviewReceipt(undefined)).toEqual(["receipt must be an object"])
  })

  it.each([
    ["contractVersion", { contractVersion: 9 as never }, "contractVersion must be 1"],
    ["id", { id: "" }, "id is required"],
    ["expiresAt", { expiresAt: Number.NaN }, "expiresAt must be a finite number"],
  ])("rejects a bad %s", (_label, overrides, expected) => {
    expect(validateActionReviewReceipt(makeReceipt(overrides))).toContain(expected)
  })

  it("prefixes nested request and decision violations", () => {
    const receipt = makeReceipt({
      request: makeRequest({ requestId: "" }),
      decision: makeDecision({ outcome: "maybe" as never }),
    })
    const errors = validateActionReviewReceipt(receipt)
    expect(errors).toContain("request: requestId is required")
    expect(errors).toContain("decision: outcome must be a known ActionReviewOutcome")
  })

  it("rejects an id that disagrees with request.requestId", () => {
    expect(validateActionReviewReceipt(makeReceipt({ id: "other" }))).toContain(
      "id must equal request.requestId"
    )
  })

  it("rejects a decision recorded against a different request", () => {
    const receipt = makeReceipt({ decision: makeDecision({ requestId: "req-2" }) })
    expect(validateActionReviewReceipt(receipt)).toContain(
      "decision.requestId must equal request.requestId"
    )
  })

  describe("effect", () => {
    it("accepts a well-formed effect", () => {
      const receipt = makeReceipt({
        effect: { status: "executed", detail: "ok", durationMs: 12, completedAt: 3_000 },
      })
      expect(validateActionReviewReceipt(receipt)).toEqual([])
    })

    it("rejects a non-object effect", () => {
      expect(validateActionReviewReceipt(makeReceipt({ effect: 1 as never }))).toContain(
        "effect must be an object"
      )
    })

    it("rejects a bad status, durationMs, and completedAt", () => {
      const receipt = makeReceipt({
        effect: {
          status: "done" as never,
          durationMs: Number.NaN,
          completedAt: Number.POSITIVE_INFINITY,
        },
      })
      const errors = validateActionReviewReceipt(receipt)
      expect(errors).toContain("effect.status must be a known ActionReviewEffectStatus")
      expect(errors).toContain("effect.durationMs must be a finite number")
      expect(errors).toContain("effect.completedAt must be a finite number")
    })
  })
})

describe("permitsExecution", () => {
  it.each([
    ["allow", true],
    ["allow_always", true],
    ["deny", false],
    ["expired", false],
    ["interrupted", false],
  ] as const)("%s → %p", (outcome, expected) => {
    expect(permitsExecution(makeDecision({ outcome }))).toBe(expected)
  })

  it("covers every outcome in the union", () => {
    expect(
      ACTION_REVIEW_OUTCOMES.filter((o) => permitsExecution(makeDecision({ outcome: o })))
    ).toEqual(["allow", "allow_always"])
  })
})
