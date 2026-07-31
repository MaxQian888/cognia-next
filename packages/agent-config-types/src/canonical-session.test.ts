import {
  computeSequenceDigest,
  fidelityRank,
  isCanonicalSession,
  SESSION_FIDELITY_LEVELS,
  validateCanonicalSession,
  type CanonicalSession,
  type CanonicalTurn,
} from "./canonical-session"

function turns(): CanonicalTurn[] {
  return [
    { turnId: "t1", role: "user", text: "hello" },
    {
      turnId: "t2",
      role: "assistant",
      text: "hi",
      toolCalls: [{ callId: "c1", toolName: "Read", resultText: "ok" }],
    },
  ]
}

function validSession(): CanonicalSession {
  const seq = turns()
  return {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: "cs-1",
      sourceRuntime: "claude-code",
      runtimeBinding: { nativeSessionId: "sdk-abc" },
      title: "T",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:01.000Z",
      turnCount: seq.length,
      importFidelity: "structured",
      sequenceDigest: computeSequenceDigest(seq),
    },
    turns: seq,
    permissions: [{ requestId: "p1", toolName: "Bash", decision: "deny" }],
    checkpoints: [{ checkpointId: "cp1", afterTurnId: "t1" }],
  }
}

describe("fidelity scale", () => {
  it("ranks the five levels monotonically, native-exact highest", () => {
    const ranks = SESSION_FIDELITY_LEVELS.map(fidelityRank)
    expect(ranks).toEqual([4, 3, 2, 1, 0])
    expect(fidelityRank("native-exact")).toBeGreaterThan(fidelityRank("contextual"))
    expect(fidelityRank("unsupported")).toBe(0)
  })
})

describe("computeSequenceDigest", () => {
  it("is deterministic and content-sensitive, ignoring volatile fields", () => {
    const a = computeSequenceDigest(turns())
    const b = computeSequenceDigest(turns().map((t) => ({ ...t, at: "2099-01-01T00:00:00Z" })))
    expect(a).toBe(b)
    const mutated = turns()
    mutated[1].text = "different"
    expect(computeSequenceDigest(mutated)).not.toBe(a)
    const extraTool = turns()
    extraTool[1].toolCalls = [...(extraTool[1].toolCalls ?? []), { callId: "c2", toolName: "Edit" }]
    expect(computeSequenceDigest(extraTool)).not.toBe(a)
  })
})

describe("validateCanonicalSession", () => {
  it("accepts a fully-populated valid session", () => {
    expect(validateCanonicalSession(validSession())).toEqual([])
    expect(isCanonicalSession(validSession())).toBe(true)
  })

  it("rejects header/turn/permission violations with named errors", () => {
    expect(validateCanonicalSession(null)).toEqual(["canonical session must be an object"])
    const errors = validateCanonicalSession({ turns: "nope" })
    expect(errors).toEqual(expect.arrayContaining(["header is required", "turns must be an array"]))

    const bad = validSession()
    ;(bad.header as { importFidelity: string }).importFidelity = "perfect"
    ;(bad.turns[0] as { role: string }).role = "narrator"
    ;(bad.permissions![0] as { decision: string }).decision = "maybe"
    const badErrors = validateCanonicalSession(bad)
    expect(badErrors).toEqual(
      expect.arrayContaining([
        "header.importFidelity must be a known fidelity level",
        "turns[0].role is invalid",
        "permissions[0].decision is invalid",
      ])
    )
  })

  it("covers partial-header and malformed-turn edges", () => {
    const noDigest = validSession() as unknown as { header: Record<string, unknown> }
    delete noDigest.header.sequenceDigest
    expect(validateCanonicalSession(noDigest)).toContain("header.sequenceDigest is required")

    const noId = validSession() as unknown as { header: Record<string, unknown> }
    noId.header.canonicalSessionId = ""
    noId.header.sourceRuntime = ""
    expect(validateCanonicalSession(noId)).toEqual(
      expect.arrayContaining([
        "header.canonicalSessionId is required",
        "header.sourceRuntime is required",
      ])
    )

    const badTurn = validSession()
    ;(badTurn.turns[0] as { turnId: string }).turnId = ""
    ;(badTurn.turns[1] as { text: unknown }).text = 42
    expect(validateCanonicalSession(badTurn)).toEqual(
      expect.arrayContaining(["turns[0].turnId is required", "turns[1].text must be a string"])
    )

    const badPermission = validSession()
    ;(badPermission.permissions as unknown[]) = [null, { requestId: "" }]
    expect(validateCanonicalSession(badPermission)).toEqual(
      expect.arrayContaining([
        "permissions[0].requestId is required",
        "permissions[1].requestId is required",
      ])
    )
  })

  it("pins header integrity: turnCount and sequenceDigest must match the turns", () => {
    const wrongCount = validSession()
    wrongCount.header.turnCount = 99
    expect(validateCanonicalSession(wrongCount)).toContain(
      "header.turnCount disagrees with turns.length"
    )

    const tampered = validSession()
    tampered.turns[0].text = "tampered"
    expect(validateCanonicalSession(tampered)).toContain(
      "header.sequenceDigest disagrees with the turn sequence"
    )
  })
})
