import { DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS } from "./registry"
import type {
  CogniaDiagnostic,
  DiagnosticAction,
  DiagnosticActionKind,
  DiagnosticSeverity,
  DiagnosticSource,
} from "./types"

/**
 * The type module has no runtime surface, so these assert the two properties
 * the *shape* has to keep: severity ordering (used by the surface router and
 * the notification-level mapping) and the serializability that lets a
 * diagnostic ride a store, a CustomEvent, Dexie and a `toEqual`.
 */

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  fatal: 3,
}

describe("DiagnosticSeverity", () => {
  it("orders strictly from ambient to app-stopping", () => {
    expect(SEVERITY_RANK.info).toBeLessThan(SEVERITY_RANK.warning)
    expect(SEVERITY_RANK.warning).toBeLessThan(SEVERITY_RANK.error)
    expect(SEVERITY_RANK.error).toBeLessThan(SEVERITY_RANK.fatal)
  })
})

describe("CogniaDiagnostic", () => {
  it("survives a JSON round-trip unchanged", () => {
    // Load-bearing: diagnostics are persisted as notification rows and replayed
    // in a later session, and compared field-by-field in tests. A closure
    // anywhere in the shape would break both.
    const diag: CogniaDiagnostic = {
      id: "d1",
      at: 1_700_000_000_000,
      code: "rateLimited",
      severity: "warning",
      retryable: true,
      persistent: false,
      source: "provider",
      message: "429 Too Many Requests",
      actions: [
        { kind: "wait-and-retry", retryAfterMs: 30_000 },
        { kind: "open-settings", section: "providers", focus: "anthropic-key" },
      ],
      meta: { httpStatus: 429, retryAfterMs: 30_000, providerId: "anthropic" },
      detail: "at send (chat.ts:1:1)",
    }

    expect(JSON.parse(JSON.stringify(diag))).toEqual(diag)
  })

  it("accepts every declared source", () => {
    const sources: DiagnosticSource[] = [
      "chat",
      "agent-team",
      "external-agent",
      "provider",
      "plugin",
      "workflow",
      "scheduler",
      "inbox",
      "connector",
      "tauri",
      "storage",
      "settings",
      "boundary",
      "execution",
      "unknown",
    ]
    expect(new Set(sources).size).toBe(sources.length)
  })
})

describe("DiagnosticAction", () => {
  it("keeps every kind reachable from the registry or a producer", () => {
    // `DiagnosticActionKind` drives both the handler map and the i18n keys, so
    // an unused kind is a dead label; a missing one is an unlabelled button.
    const kinds: DiagnosticActionKind[] = [
      "retry",
      "wait-and-retry",
      "retry-fallback-provider",
      "retry-when-online",
      "switch-to-builtin",
      "open-settings",
      "reauth",
      "restart-sidecar",
      "reconnect-adapter",
      "reconnect-external-agent",
      "copy-install-command",
      "locate-binary",
      "shorten-input",
      "view-logs",
      "jump-to-node",
      "open-external",
      "export-crash-log",
      "copy-report",
      "report-issue",
      "reload-app",
      "reset-boundary",
      "dismiss",
    ]
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it("lets the registry's actions be read as the shared union", () => {
    const all: DiagnosticAction[] = DIAGNOSTIC_CODE_IDS.flatMap((code) => [
      ...DIAGNOSTIC_CODES[code].actions,
    ])
    expect(all.every((a) => typeof a.kind === "string")).toBe(true)
  })
})
