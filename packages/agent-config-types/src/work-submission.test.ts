import {
  isClaimableDispatchState,
  isExecutionContextRefV1,
  isSuccessfulOutcome,
  isWorkAttachmentRefV1,
  isWorkInputBatchRefV1,
  isWorkReceiptV1,
  isWorkSubmissionIntentV1,
  validateWorkSubmissionIntentV1,
  workCommandId,
  WORK_SUBMISSION_CONTRACT_VERSION,
  WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES,
  type ExecutionContextRefV1,
  type WorkAttachmentRefV1,
  type WorkDispatchStateV1,
  type WorkInputBatchRefV1,
  type WorkReceiptV1,
  type WorkSubmissionIntentV1,
  type WorkTerminalOutcomeV1,
} from "./work-submission"

const DIGEST = "a".repeat(64)

function intent(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
    idempotencyKey: "chat:session-1:action-1",
    source: { kind: "chat", sourceId: "session-1" },
    scope: { accountId: "account-1", runtimeTargetId: "target-1", sessionId: "session-1" },
    availabilityPolicy: "wait",
    ...overrides,
  }
}

function attachment(overrides: Partial<WorkAttachmentRefV1> = {}): unknown {
  return {
    assetId: "asset-1",
    digest: DIGEST,
    mediaType: "image/png",
    size: 1024,
    fileName: "screenshot.png",
    ...overrides,
  }
}

describe("validateWorkSubmissionIntentV1", () => {
  it("accepts a minimal well-formed submission", () => {
    const result = validateWorkSubmissionIntentV1(intent())
    expect(result).toEqual({ ok: true, value: intent() })
  })

  it("accepts an optional workItemRef", () => {
    const value = intent({ workItemRef: { kind: "agent-task", id: "task-1" } })
    expect(validateWorkSubmissionIntentV1(value).ok).toBe(true)
  })

  it("rejects a non-object", () => {
    expect(validateWorkSubmissionIntentV1("nope")).toEqual({
      ok: false,
      errors: ["submission must be an object"],
    })
  })

  it("rejects a mismatched contract version", () => {
    const result = validateWorkSubmissionIntentV1(intent({ contractVersion: 2 }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "unsupported work submission contract version"
    )
  })

  it("rejects an undeclared top-level field", () => {
    // The guard is closed: a newer peer's extra field must not ride along
    // unvalidated into storage.
    const result = validateWorkSubmissionIntentV1(intent({ smuggled: "payload" }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain("submission carries unknown fields")
  })

  it("rejects an unknown source kind", () => {
    const result = validateWorkSubmissionIntentV1(
      intent({ source: { kind: "not-a-surface", sourceId: "x" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain("source.kind is not a known work source")
  })

  it("rejects an unknown availability policy", () => {
    const result = validateWorkSubmissionIntentV1(intent({ availabilityPolicy: "retry-forever" }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "availabilityPolicy is not a known policy"
    )
  })

  it("rejects an undeclared field inside workItemRef", () => {
    const result = validateWorkSubmissionIntentV1(
      intent({ workItemRef: { kind: "agent-task", id: "task-1", rogue: 1 } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain("workItemRef carries unknown fields")
  })

  it("rejects an unknown workItemRef kind", () => {
    const result = validateWorkSubmissionIntentV1(
      intent({ workItemRef: { kind: "sticky-note", id: "x" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "workItemRef.kind is not a known work item"
    )
  })

  it.each([
    ["source", { kind: "chat", sourceId: "x", rogue: 1 }, "source carries unknown fields"],
    ["scope", { accountId: "a", runtimeTargetId: "t", rogue: 1 }, "scope carries unknown fields"],
  ])("rejects an undeclared field inside %s", (key, value, expected) => {
    const result = validateWorkSubmissionIntentV1(intent({ [key]: value }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(expected)
  })

  it.each([
    ["source", "nope", "source must be an object"],
    ["scope", 7, "scope must be an object"],
    ["workItemRef", "nope", "workItemRef must be an object"],
  ])("rejects a non-object %s", (key, value, expected) => {
    const result = validateWorkSubmissionIntentV1(intent({ [key]: value }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(expected)
  })

  it("rejects a missing account id", () => {
    const result = validateWorkSubmissionIntentV1(
      intent({ scope: { accountId: "", runtimeTargetId: "t" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "scope.accountId must be a non-empty string"
    )
  })

  it("rejects a secret-shaped ref", () => {
    const result = validateWorkSubmissionIntentV1(intent({ idempotencyKey: "sk-abc123" }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "idempotencyKey: secret-shaped value in a ref position"
    )
  })

  it("rejects a host-local absolute path in a ref position", () => {
    // Absolute paths do not survive a host boundary; the receiving host
    // resolves its own root from a logical ref instead.
    const result = validateWorkSubmissionIntentV1(
      intent({ scope: { accountId: "a", runtimeTargetId: "t", projectId: "/srv/project" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "scope.projectId: machine-local absolute path is not a stable ref"
    )
  })

  it("rejects a URL-shaped source id", () => {
    const result = validateWorkSubmissionIntentV1(
      intent({ source: { kind: "chat", sourceId: "https://evil.example" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "source.sourceId: URL-shaped value in a ref position"
    )
  })

  it("accepts an omitted optional ref but rejects an empty one", () => {
    expect(validateWorkSubmissionIntentV1(intent()).ok).toBe(true)
    const result = validateWorkSubmissionIntentV1(
      intent({ scope: { accountId: "a", runtimeTargetId: "t", sessionId: "" } })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "scope.sessionId must be a non-empty string"
    )
  })

  it("rejects a single field larger than the inline text budget", () => {
    const oversized = "x".repeat(WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES + 1)
    const result = validateWorkSubmissionIntentV1(intent({ idempotencyKey: oversized }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "idempotencyKey exceeds the inline text budget"
    )
  })

  it("rejects an envelope larger than the size budget", () => {
    // Each id stays under the per-field budget; together they blow the
    // envelope budget, which is the limit that protects the transport.
    const chunk = "x".repeat(WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES - 1)
    const result = validateWorkSubmissionIntentV1(
      intent({
        idempotencyKey: chunk,
        source: { kind: "chat", sourceId: chunk, triggerId: chunk },
        scope: { accountId: chunk, runtimeTargetId: chunk },
      })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toContain(
      "submission envelope exceeds the size budget"
    )
  })

  it("reports the structural error rather than the size error when both apply", () => {
    const chunk = "x".repeat(WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES - 1)
    const result = validateWorkSubmissionIntentV1(
      intent({
        availabilityPolicy: "bogus",
        idempotencyKey: chunk,
        source: { kind: "chat", sourceId: chunk, triggerId: chunk },
        scope: { accountId: chunk, runtimeTargetId: chunk },
      })
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).not.toContain(
      "submission envelope exceeds the size budget"
    )
  })

  it("collects every violation rather than stopping at the first", () => {
    const result = validateWorkSubmissionIntentV1({
      contractVersion: 99,
      idempotencyKey: "",
      source: { kind: "bogus", sourceId: "" },
      scope: { accountId: "", runtimeTargetId: "" },
      availabilityPolicy: "bogus",
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors.length).toBeGreaterThan(4)
  })
})

describe("isWorkSubmissionIntentV1", () => {
  it("narrows a valid submission", () => {
    const value: unknown = intent()
    expect(isWorkSubmissionIntentV1(value)).toBe(true)
    if (isWorkSubmissionIntentV1(value)) {
      const typed: WorkSubmissionIntentV1 = value
      expect(typed.source.kind).toBe("chat")
    }
  })

  it("rejects an invalid submission", () => {
    expect(isWorkSubmissionIntentV1(intent({ availabilityPolicy: "bogus" }))).toBe(false)
  })
})

describe("isWorkAttachmentRefV1", () => {
  it("accepts a reference-only attachment", () => {
    expect(isWorkAttachmentRefV1(attachment())).toBe(true)
  })

  it("rejects inline bytes riding along", () => {
    expect(isWorkAttachmentRefV1({ ...(attachment() as object), bytes: "AAAA" })).toBe(false)
  })

  it.each([
    ["digest that is not sha-256 hex", { digest: "abc" }],
    ["uppercase digest", { digest: "A".repeat(64) }],
    ["negative size", { size: -1 }],
    ["fractional size", { size: 1.5 }],
    ["empty media type", { mediaType: "" }],
  ])("rejects %s", (_label, override) => {
    expect(isWorkAttachmentRefV1(attachment(override as Partial<WorkAttachmentRefV1>))).toBe(false)
  })

  it.each([
    ["a path separator", "nested/evil.png"],
    ["a backslash separator", "nested\\evil.png"],
    ["a traversal segment", ".."],
    ["a single dot", "."],
    ["an absolute path", "/etc/passwd"],
  ])("rejects a file name containing %s", (_label, fileName) => {
    expect(isWorkAttachmentRefV1(attachment({ fileName }))).toBe(false)
  })

  it("accepts a zero-byte asset", () => {
    expect(isWorkAttachmentRefV1(attachment({ size: 0 }))).toBe(true)
  })

  it("rejects a non-object", () => {
    expect(isWorkAttachmentRefV1(null)).toBe(false)
  })
})

describe("isWorkInputBatchRefV1", () => {
  const batch: WorkInputBatchRefV1 = {
    inputBatchId: "batch-1",
    digest: "wsv1-abc",
    visibleMessageIds: ["message-1", "message-2"],
    attachments: [attachment() as WorkAttachmentRefV1],
  }

  it("accepts a well-formed batch reference", () => {
    expect(isWorkInputBatchRefV1(batch)).toBe(true)
  })

  it("accepts an empty attachment list", () => {
    expect(isWorkInputBatchRefV1({ ...batch, attachments: [] })).toBe(true)
  })

  it("rejects raw content in place of a reference", () => {
    expect(isWorkInputBatchRefV1({ ...batch, text: "the actual prompt" })).toBe(false)
  })

  it("rejects a malformed attachment", () => {
    expect(
      isWorkInputBatchRefV1({ ...batch, attachments: [attachment({ digest: "short" })] })
    ).toBe(false)
  })

  it("rejects a non-array of message ids", () => {
    expect(isWorkInputBatchRefV1({ ...batch, visibleMessageIds: "message-1" })).toBe(false)
  })

  it("rejects an empty message id", () => {
    expect(isWorkInputBatchRefV1({ ...batch, visibleMessageIds: [""] })).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(isWorkInputBatchRefV1(undefined)).toBe(false)
  })
})

describe("isExecutionContextRefV1", () => {
  const bundle: ExecutionContextRefV1 = {
    contextBundleId: "bundle-1",
    digest: "wsv1-def",
  }

  it("accepts a minimal bundle reference", () => {
    expect(isExecutionContextRefV1(bundle)).toBe(true)
  })

  it("accepts optional logical refs", () => {
    expect(
      isExecutionContextRefV1({
        ...bundle,
        projectId: "project-1",
        workspaceBindingRef: "workspace-main",
        baseRef: "refs/heads/dev",
      })
    ).toBe(true)
  })

  it.each([
    ["workspaceBindingRef", "/Users/me/project"],
    ["baseRef", "C:\\repo"],
    ["projectId", "/srv/p"],
  ])("rejects an absolute path in %s", (key, value) => {
    // This is the structural enforcement point for "absolute paths stay on the
    // executing host" — the bundle crosses a boundary, the path must not.
    expect(isExecutionContextRefV1({ ...bundle, [key]: value })).toBe(false)
  })

  it("rejects an undeclared field", () => {
    expect(isExecutionContextRefV1({ ...bundle, cwd: "relative/dir" })).toBe(false)
  })

  it("rejects a missing digest", () => {
    expect(isExecutionContextRefV1({ contextBundleId: "bundle-1", digest: "" })).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(isExecutionContextRefV1(42)).toBe(false)
  })
})

describe("isWorkReceiptV1", () => {
  const receipt: WorkReceiptV1 = {
    contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
    submissionId: "submission-1",
    runId: "run-1",
    turnId: "turn-1",
    inputBatchId: "batch-1",
    state: "accepted",
    acceptedAt: 1_755_000_000_000,
  }

  it("accepts a well-formed receipt", () => {
    expect(isWorkReceiptV1(receipt)).toBe(true)
  })

  it.each(["accepted", "blocked", "queued", "terminal"])("accepts state %s", (state) => {
    expect(isWorkReceiptV1({ ...receipt, state })).toBe(true)
  })

  it("rejects an unknown state", () => {
    expect(isWorkReceiptV1({ ...receipt, state: "running" })).toBe(false)
  })

  it("rejects a mismatched contract version", () => {
    expect(isWorkReceiptV1({ ...receipt, contractVersion: 2 })).toBe(false)
  })

  it("rejects an undeclared field", () => {
    expect(isWorkReceiptV1({ ...receipt, hostSecret: "x" })).toBe(false)
  })

  it("rejects a negative timestamp", () => {
    expect(isWorkReceiptV1({ ...receipt, acceptedAt: -1 })).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(isWorkReceiptV1([])).toBe(false)
  })
})

describe("isClaimableDispatchState", () => {
  it.each<[WorkDispatchStateV1, boolean]>([
    ["pending", true],
    // A blocked submission is claimable: an unavailable target is exactly the
    // condition a later sweep re-tests.
    ["blocked", true],
    ["claimed", false],
    ["dispatched", false],
    ["settled", false],
  ])("returns %s -> %s", (state, expected) => {
    expect(isClaimableDispatchState(state)).toBe(expected)
  })
})

describe("isSuccessfulOutcome", () => {
  it.each<[WorkTerminalOutcomeV1, boolean]>([
    ["completed", true],
    // An empty reply is a legitimate finished turn, not a failure.
    ["no_response", true],
    ["failed", false],
    ["cancelled", false],
    ["recovery_required", false],
  ])("returns %s -> %s", (outcome, expected) => {
    expect(isSuccessfulOutcome(outcome)).toBe(expected)
  })
})

describe("workCommandId", () => {
  it("is stable per submission and attempt", () => {
    expect(workCommandId("submission-1", "attempt-1")).toBe("submission-1:attempt-1")
    expect(workCommandId("submission-1", "attempt-1")).toBe(
      workCommandId("submission-1", "attempt-1")
    )
  })

  it("differs across attempts so a retry is a distinct runtime command", () => {
    expect(workCommandId("submission-1", "attempt-1")).not.toBe(
      workCommandId("submission-1", "attempt-2")
    )
  })
})
