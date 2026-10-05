import {
  CODEX_PRESET_FAMILY,
  ExternalAgentBindingError,
  checkPinnedExternalAgent,
  compareExternalAgentCandidates,
  isPresetBindingAmbiguous,
  listPinnableExternalAgents,
  normalizePinnedConfigId,
  pickExternalAgentForPreset,
  presetFamilyOf,
  presetSatisfiesDeclared,
  resolveExternalAgentBinding,
  toExternalAgentCandidate,
  type ExternalAgentCandidate,
} from "./agent-binding"

function candidate(overrides: Partial<ExternalAgentCandidate> & { id: string }) {
  return {
    presetId: "codex",
    enabled: true,
    connected: false,
    ...overrides,
  } satisfies ExternalAgentCandidate
}

describe("preset families", () => {
  it("groups the Codex surfaces and leaves every other preset alone", () => {
    expect(presetFamilyOf("codex-acp")).toBe(CODEX_PRESET_FAMILY)
    expect(presetFamilyOf("claude-code")).toEqual(["claude-code"])
  })

  it("accepts a same-family config and rejects anything else", () => {
    expect(presetSatisfiesDeclared("codex", "codex-app-server")).toBe(true)
    expect(presetSatisfiesDeclared("gemini-cli", "gemini-cli")).toBe(true)
    expect(presetSatisfiesDeclared("codex", "claude-code")).toBe(false)
    expect(presetSatisfiesDeclared("codex", undefined)).toBe(false)
  })
})

describe("toExternalAgentCandidate", () => {
  it("reads the preset, enabled flag, connection and gateway binding", () => {
    expect(
      toExternalAgentCandidate(
        {
          id: "a",
          enabled: true,
          metadata: { preset: "codex" },
          createdAt: "2026-01-01T00:00:00.000Z",
          cogniaModel: { providerId: "p", modelId: "m" },
        },
        "connected"
      )
    ).toEqual({
      id: "a",
      presetId: "codex",
      enabled: true,
      connected: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      gatewayBound: true,
    })
  })

  it("lets the caller override the preset read, including to none", () => {
    const config = { id: "a", enabled: false, metadata: { preset: "gone-plugin" } }
    expect(toExternalAgentCandidate(config, undefined, null)).toMatchObject({
      presetId: undefined,
      enabled: false,
      connected: false,
      gatewayBound: false,
    })
  })
})

describe("compareExternalAgentCandidates / pickExternalAgentForPreset", () => {
  it("orders enabled, then earliest createdAt, then id — never by connection", () => {
    const sorted = [
      candidate({ id: "disabled-old", enabled: false, createdAt: "2020-01-01T00:00:00Z" }),
      candidate({ id: "undated" }),
      candidate({ id: "b-same", createdAt: new Date("2025-01-01T00:00:00Z") }),
      candidate({ id: "a-same", createdAt: new Date("2025-01-01T00:00:00Z") }),
      candidate({ id: "new-connected", connected: true, createdAt: "2026-06-01T00:00:00Z" }),
      candidate({ id: "bad-date", createdAt: "not a date" }),
      candidate({ id: "old", createdAt: 1_000 }),
    ]
      .sort(compareExternalAgentCandidates)
      .map((c) => c.id)
    expect(sorted).toEqual([
      "old",
      "a-same",
      "b-same",
      "new-connected",
      "bad-date",
      "undated",
      "disabled-old",
    ])
  })

  it("does not move a bare preset onto whichever duplicate is connected", () => {
    const original = candidate({ id: "read-only", createdAt: "2025-01-01T00:00:00Z" })
    const copy = candidate({
      id: "workspace-write",
      createdAt: "2025-03-01T00:00:00Z",
      connected: true,
    })
    expect(pickExternalAgentForPreset([copy, original], "codex")?.id).toBe("read-only")
  })

  it("reports a bare preset as ambiguous only with several enabled candidates", () => {
    const one = candidate({ id: "one" })
    const two = candidate({ id: "two" })
    const off = candidate({ id: "off", enabled: false })
    const bound = candidate({ id: "bound", gatewayBound: true })
    expect(isPresetBindingAmbiguous([one, off, bound], "codex")).toBe(false)
    expect(isPresetBindingAmbiguous([one, two], "codex")).toBe(true)
    expect(isPresetBindingAmbiguous([one, two], "gemini-cli")).toBe(false)
  })

  it("does not depend on insertion order", () => {
    const a = candidate({ id: "first-created", createdAt: "2025-01-01T00:00:00Z" })
    const b = candidate({ id: "second-created", createdAt: "2025-02-01T00:00:00Z" })
    expect(pickExternalAgentForPreset([b, a], "codex")?.id).toBe("first-created")
    expect(pickExternalAgentForPreset([a, b], "codex")?.id).toBe("first-created")
  })

  it("matches the exact preset only and never picks a gateway-bound config", () => {
    const candidates = [
      candidate({ id: "app-server", presetId: "codex-app-server" }),
      candidate({ id: "bound", gatewayBound: true, connected: true }),
      candidate({ id: "plain" }),
    ]
    expect(pickExternalAgentForPreset(candidates, "codex")?.id).toBe("plain")
    expect(pickExternalAgentForPreset(candidates, "gemini-cli")).toBeUndefined()
  })
})

describe("listPinnableExternalAgents", () => {
  it("lists the whole family in selection order, disabled configs included", () => {
    const configs = [
      { id: "claude", enabled: true, metadata: { preset: "claude-code" } },
      { id: "off", enabled: false, metadata: { preset: "codex" }, createdAt: "2020-01-01" },
      { id: "late", enabled: true, metadata: { preset: "codex" }, createdAt: "2026-01-01" },
      { id: "early", enabled: true, metadata: { preset: "codex-app-server" }, createdAt: "2024" },
    ]
    expect(listPinnableExternalAgents(configs, "codex").map((c) => c.id)).toEqual([
      "early",
      "late",
      "off",
    ])
  })
})

describe("checkPinnedExternalAgent", () => {
  it("reports missing, disabled and preset-mismatch in that order", () => {
    expect(checkPinnedExternalAgent(undefined, "codex")).toEqual({ ok: false, problem: "missing" })
    expect(
      checkPinnedExternalAgent(
        candidate({ id: "x", enabled: false, presetId: "gemini-cli" }),
        "codex"
      )
    ).toEqual({ ok: false, problem: "disabled" })
    expect(
      checkPinnedExternalAgent(candidate({ id: "x", presetId: "gemini-cli" }), "codex")
    ).toEqual({ ok: false, problem: "preset-mismatch" })
    expect(checkPinnedExternalAgent(candidate({ id: "x" }), "codex")).toEqual({ ok: true })
  })
})

describe("normalizePinnedConfigId", () => {
  it("treats blank and non-string values as no pin", () => {
    expect(normalizePinnedConfigId(undefined)).toBeUndefined()
    expect(normalizePinnedConfigId("   ")).toBeUndefined()
    expect(normalizePinnedConfigId(42)).toBeUndefined()
    expect(normalizePinnedConfigId(" id-1 ")).toBe("id-1")
  })
})

describe("resolveExternalAgentBinding", () => {
  const live = [
    candidate({ id: "lenient", connected: true, createdAt: "2024-01-01T00:00:00Z" }),
    candidate({ id: "strict", createdAt: "2025-01-01T00:00:00Z" }),
  ]

  it("runs exactly the pinned config even when the preset order would pick another", () => {
    expect(
      resolveExternalAgentBinding({ presetId: "codex", configId: "strict" }, { live })
    ).toEqual({
      kind: "pinned",
      agentId: "strict",
    })
    expect(resolveExternalAgentBinding({ presetId: "codex" }, { live })).toEqual({
      kind: "preset",
      agentId: "lenient",
    })
  })

  it("reads a pin from the stored configs before the live ones", () => {
    const stored = [candidate({ id: "strict", enabled: false })]
    expect(() =>
      resolveExternalAgentBinding({ presetId: "codex", configId: "strict" }, { live, stored })
    ).toThrow(ExternalAgentBindingError)
  })

  it.each([
    ["missing", "nope", undefined, /no longer exists/],
    ["disabled", "off", candidate({ id: "off", enabled: false }), /is disabled/],
    [
      "preset-mismatch",
      "gem",
      candidate({ id: "gem", presetId: "gemini-cli" }),
      /now runs preset "gemini-cli"/,
    ],
  ] as const)(
    "fails loudly for a %s pin without falling back",
    (problem, configId, extra, message) => {
      const candidates = { live: extra ? [...live, extra] : live }
      let caught: unknown
      try {
        resolveExternalAgentBinding({ presetId: "codex", configId }, candidates)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ExternalAgentBindingError)
      const error = caught as ExternalAgentBindingError
      expect(error.problem).toBe(problem)
      expect(error.configId).toBe(configId)
      expect(error.declaredPresetId).toBe("codex")
      expect(error.message).toMatch(message)
      expect(error.message).toContain("NOT replaced by another config")
    }
  )

  it("returns a null preset pick when no live config of the preset exists", () => {
    expect(resolveExternalAgentBinding({ presetId: "gemini-cli" }, { live })).toEqual({
      kind: "preset",
      agentId: null,
    })
  })

  it("describes an unavailable pin with the readiness detail", () => {
    const error = new ExternalAgentBindingError(
      "unavailable",
      "x",
      "codex",
      undefined,
      "spawn failed"
    )
    expect(error.message).toMatch(/could not be started: spawn failed/)
    expect(error.name).toBe("ExternalAgentBindingError")
  })
})
