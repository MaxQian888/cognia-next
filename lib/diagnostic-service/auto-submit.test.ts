import {
  AUTO_SUBMIT_LEDGER_LIMIT,
  AUTO_SUBMIT_MAX_ATTEMPTS,
  autoSubmitErrorCode,
  incidentLedgerKey,
  loadAutoSubmitLedger,
  runAutoSubmit,
  runAutoSubmitOnce,
  saveAutoSubmitLedger,
  selectAutoSubmitCandidates,
  type AutoSubmitIncident,
  type AutoSubmitLedger,
  type AutoSubmitStoreDeps,
  type RunAutoSubmitInput,
} from "./auto-submit"
import type { StoredDiagnosticConnection } from "./connection"
import { DEFAULT_SUBMISSION_CONSENT, type SubmitIncidentResult } from "./submit-incident"

function memoryStore(): Required<AutoSubmitStoreDeps> & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    local: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    },
  }
}

const SINCE = "2026-10-01T00:00:00.000Z"

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: true,
  autoSubmitSince: SINCE,
  lastKnownRole: null,
}

function report(over: Partial<AutoSubmitIncident> = {}): AutoSubmitIncident {
  return {
    id: "crash-1",
    runtime: "desktop",
    source: "panic",
    capturedAt: "2026-10-02T00:00:00.000Z",
    state: "detected",
    ...over,
  }
}

function receipt(code: string): SubmitIncidentResult {
  return {
    uploadedParts: 2,
    resumedParts: 0,
    screenshotUnavailable: false,
    supportCode: code,
    clientState: "processing",
  }
}

function input(over: Partial<RunAutoSubmitInput> = {}): RunAutoSubmitInput {
  return {
    accountId: "account-a",
    connection,
    incidents: [report()],
    submit: jest.fn(async () => receipt("SUP-1")),
    saveConnection: jest.fn(),
    now: () => new Date("2026-10-03T00:00:00.000Z"),
    store: memoryStore(),
    ...over,
  }
}

describe("selectAutoSubmitCandidates", () => {
  it("only takes reports captured since the switch went on, and still waiting on the user", () => {
    const candidates = selectAutoSubmitCandidates({
      connection,
      ledger: {},
      incidents: [
        report({ id: "old", capturedAt: "2026-09-30T23:59:59.000Z" }),
        report({ id: "new" }),
        report({ id: "packaged", state: "packaged" }),
        report({ id: "legacy", state: "awaitingConsent" }),
        report({ id: "sent", state: "processing" }),
        report({ id: "garbled", capturedAt: "not a date" }),
      ],
    })
    expect(candidates.map((incident) => incident.id)).toEqual(["new", "packaged", "legacy"])
  })

  it("sends nothing while the switch is off or unstamped", () => {
    expect(
      selectAutoSubmitCandidates({
        connection: { ...connection, autoSubmit: false },
        ledger: {},
        incidents: [report()],
      })
    ).toEqual([])
    expect(
      selectAutoSubmitCandidates({
        connection: { ...connection, autoSubmitSince: undefined },
        ledger: {},
        incidents: [report()],
      })
    ).toEqual([])
  })

  it("orders oldest first so support codes follow the crashes", () => {
    const candidates = selectAutoSubmitCandidates({
      connection,
      ledger: {},
      incidents: [
        report({ id: "b", capturedAt: "2026-10-02T02:00:00.000Z" }),
        report({ id: "a", capturedAt: "2026-10-02T01:00:00.000Z" }),
      ],
    })
    expect(candidates.map((incident) => incident.id)).toEqual(["a", "b"])
  })

  it("honours the ledger: sent never again, refused never again, retryable until the cap", () => {
    const ledger: AutoSubmitLedger = {
      "desktop:sent": { attempts: 1, lastAttemptAt: SINCE, supportCode: "S", errorCode: null },
      "desktop:refused": {
        attempts: 1,
        lastAttemptAt: SINCE,
        supportCode: null,
        errorCode: "unauthorized",
      },
      "desktop:offline": {
        attempts: 1,
        lastAttemptAt: SINCE,
        supportCode: null,
        errorCode: "network_unavailable",
      },
      "desktop:exhausted": {
        attempts: AUTO_SUBMIT_MAX_ATTEMPTS,
        lastAttemptAt: SINCE,
        supportCode: null,
        errorCode: "network_unavailable",
      },
      // The app died mid-send: no outcome was recorded.
      "desktop:interrupted": {
        attempts: 1,
        lastAttemptAt: SINCE,
        supportCode: null,
        errorCode: null,
      },
    }
    const candidates = selectAutoSubmitCandidates({
      connection,
      ledger,
      incidents: ["sent", "refused", "offline", "exhausted", "interrupted"].map((id) =>
        report({ id })
      ),
    })
    expect(candidates.map((incident) => incident.id).sort()).toEqual(["interrupted", "offline"])
  })
})

describe("runAutoSubmit", () => {
  it("sends each new report with the default consent and returns its receipt", async () => {
    const run = input()
    const outcomes = await runAutoSubmit(run)
    expect(run.submit).toHaveBeenCalledWith(run.incidents[0], DEFAULT_SUBMISSION_CONSENT)
    // Nothing optional: no minidump, no screenshot, no description.
    expect(DEFAULT_SUBMISSION_CONSENT).toEqual({
      includeMinidump: false,
      includeScreenshot: false,
      description: "",
    })
    expect(outcomes).toEqual([
      { kind: "submitted", incident: run.incidents[0], receipt: receipt("SUP-1") },
    ])
  })

  it("never sends the same report twice across passes", async () => {
    const store = memoryStore()
    const first = input({ store })
    await runAutoSubmit(first)
    const second = input({ store })
    await expect(runAutoSubmit(second)).resolves.toEqual([])
    expect(second.submit).not.toHaveBeenCalled()
  })

  it("records the attempt before sending, so a crash mid-upload still counts", async () => {
    const store = memoryStore()
    let seenDuringSend: AutoSubmitLedger | null = null
    await runAutoSubmit(
      input({
        store,
        submit: jest.fn(async () => {
          seenDuringSend = loadAutoSubmitLedger("account-a", store)
          return receipt("SUP-1")
        }),
      })
    )
    expect(seenDuringSend).toEqual({
      "desktop:crash-1": {
        attempts: 1,
        lastAttemptAt: "2026-10-03T00:00:00.000Z",
        supportCode: null,
        errorCode: null,
      },
    })
  })

  it("retries a failure the service may get over, up to the cap", async () => {
    const store = memoryStore()
    const submit = jest.fn(async () => {
      throw { code: "network_unavailable" }
    })
    for (let pass = 1; pass <= AUTO_SUBMIT_MAX_ATTEMPTS; pass += 1) {
      const outcomes = await runAutoSubmit(input({ store, submit }))
      expect(outcomes).toEqual([
        expect.objectContaining({
          kind: "failed",
          errorCode: "network_unavailable",
          willRetry: pass < AUTO_SUBMIT_MAX_ATTEMPTS,
        }),
      ])
    }
    await expect(runAutoSubmit(input({ store, submit }))).resolves.toEqual([])
    expect(submit).toHaveBeenCalledTimes(AUTO_SUBMIT_MAX_ATTEMPTS)
  })

  it("does not retry a refusal", async () => {
    const store = memoryStore()
    const submit = jest.fn(async () => {
      throw { code: "unauthorized" }
    })
    const outcomes = await runAutoSubmit(input({ store, submit }))
    expect(outcomes[0]).toMatchObject({ kind: "failed", willRetry: false })
    await runAutoSubmit(input({ store, submit }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it("stamps a switch set while this was dormant, and sends nothing that pass", async () => {
    const run = input({ connection: { ...connection, autoSubmitSince: undefined } })
    await expect(runAutoSubmit(run)).resolves.toEqual([])
    expect(run.submit).not.toHaveBeenCalled()
    expect(run.saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ autoSubmit: true, autoSubmitSince: "2026-10-03T00:00:00.000Z" })
    )
  })

  it("does nothing at all with the switch off", async () => {
    const run = input({ connection: { ...connection, autoSubmit: false } })
    await expect(runAutoSubmit(run)).resolves.toEqual([])
    expect(run.submit).not.toHaveBeenCalled()
    expect(run.saveConnection).not.toHaveBeenCalled()
  })
})

describe("runAutoSubmitOnce", () => {
  it("collapses concurrent passes for one account onto one run", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = jest.fn(async () => {
      await gate
      return receipt("SUP-1")
    })
    const store = memoryStore()
    const first = runAutoSubmitOnce(input({ store, submit }))
    const second = runAutoSubmitOnce(input({ store, submit }))
    expect(second).toBe(first)
    release()
    await first
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe("ledger storage", () => {
  it("discards an unreadable blob instead of trusting it", () => {
    const store = memoryStore()
    store.map.set("cognia.diagnostic-service.auto-submit.account-a", "{not json")
    expect(loadAutoSubmitLedger("account-a", store)).toEqual({})
    expect(store.map.has("cognia.diagnostic-service.auto-submit.account-a")).toBe(false)
  })

  it("drops malformed entries and keeps the newest up to the limit", () => {
    const store = memoryStore()
    const ledger: AutoSubmitLedger = {}
    for (let index = 0; index < AUTO_SUBMIT_LEDGER_LIMIT + 5; index += 1) {
      ledger[`desktop:${index}`] = {
        attempts: 1,
        lastAttemptAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        supportCode: "S",
        errorCode: null,
      }
    }
    saveAutoSubmitLedger("account-a", ledger, store)
    const loaded = loadAutoSubmitLedger("account-a", store)
    expect(Object.keys(loaded)).toHaveLength(AUTO_SUBMIT_LEDGER_LIMIT)
    expect(loaded["desktop:0"]).toBeUndefined()
    expect(loaded[`desktop:${AUTO_SUBMIT_LEDGER_LIMIT + 4}`]).toBeDefined()

    store.map.set(
      "cognia.diagnostic-service.auto-submit.account-a",
      JSON.stringify({ good: loaded[`desktop:${AUTO_SUBMIT_LEDGER_LIMIT + 4}`], bad: { x: 1 } })
    )
    expect(Object.keys(loadAutoSubmitLedger("account-a", store))).toEqual(["good"])
  })

  it("keys desktop stems and mobile ids apart", () => {
    expect(incidentLedgerKey({ id: "x", runtime: "desktop" })).not.toBe(
      incidentLedgerKey({ id: "x", runtime: "mobile" })
    )
  })
})

describe("autoSubmitErrorCode", () => {
  it("reads a code from a string or a coded error and degrades the rest", () => {
    expect(autoSubmitErrorCode("ingest_disabled")).toBe("ingest_disabled")
    expect(autoSubmitErrorCode({ code: "unauthorized" })).toBe("unauthorized")
    expect(autoSubmitErrorCode(new Error("boom"))).toBe("submission_failed")
  })
})
