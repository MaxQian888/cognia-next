import {
  deleteMobileCrashReport,
  getMobileCrashCapabilities,
  listMobileCrashReports,
  readMobileCrashReport,
  recordMobileCrashReceipt,
  type CogniaCrashLoader,
  type MobileCrashReport,
  type MobileCrashSummary,
} from "./crash-diagnostics"

const summary: MobileCrashSummary = {
  incidentId: "incident-1",
  source: "android-acra",
  detectedAt: 1_700_000_000_000,
  state: "detected",
  sizeBytes: 2048,
}

const report: MobileCrashReport = {
  ...summary,
  schemaVersion: "cognia-mobile-crash-v1",
  redactionVersion: "mobile-v1",
  payload: { STACK_TRACE: "example" },
}

function makeLoader(platform: "android" | "ios" = "android") {
  const plugin = {
    capabilities: jest.fn(async () => ({
      platform,
      javaCrash: platform === "android" ? "supported" : undefined,
      nativeCrash: "supported",
      anr: platform === "android" ? "exit-info" : "unavailable",
      applicationExitInfo: platform === "android",
      metricKit: platform === "ios",
      apiLevel: platform === "android" ? 35 : undefined,
      osVersion: platform === "ios" ? 18 : undefined,
      retentionDays: 30,
      maxIncidents: 50,
    })),
    listPending: jest.fn(async () => ({ incidents: [summary] })),
    readPending: jest.fn(async () => ({ incident: report })),
    deletePending: jest.fn(async () => undefined),
    markReceipt: jest.fn(async () => undefined),
  }
  return { loader: (async () => plugin) as CogniaCrashLoader, plugin }
}

describe("Capacitor crash diagnostics", () => {
  it("normalizes Android native capabilities into the shared matrix", async () => {
    const { loader } = makeLoader("android")
    const result = await getMobileCrashCapabilities(loader)

    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.value.platform).toBe("capacitor-android")
    expect(result.value.capabilities.nativeCrash.status).toBe("supported")
    expect(result.value.capabilities.anr.status).toBe("supported")
  })

  it("normalizes iOS native capabilities into the shared matrix", async () => {
    const { loader } = makeLoader("ios")
    const result = await getMobileCrashCapabilities(loader)

    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.value.platform).toBe("capacitor-ios")
    expect(result.value.capabilities.systemDiagnostics.status).toBe("supported")
  })

  it("lists and reads locally retained reports", async () => {
    const { loader, plugin } = makeLoader()

    await expect(listMobileCrashReports(loader)).resolves.toEqual({ kind: "ok", value: [summary] })
    await expect(readMobileCrashReport("incident-1", loader)).resolves.toEqual({
      kind: "ok",
      value: report,
    })
    expect(plugin.readPending).toHaveBeenCalledWith({ incidentId: "incident-1" })
  })

  it("deletes local reports and records server receipts through the native store", async () => {
    const { loader, plugin } = makeLoader()

    await expect(deleteMobileCrashReport("incident-1", loader)).resolves.toEqual({ kind: "ok" })
    await expect(
      recordMobileCrashReceipt("incident-1", "SUP-123", "accepted", loader)
    ).resolves.toEqual({ kind: "ok" })
    expect(plugin.deletePending).toHaveBeenCalledWith({ incidentId: "incident-1" })
    expect(plugin.markReceipt).toHaveBeenCalledWith({
      incidentId: "incident-1",
      receiptCode: "SUP-123",
      state: "accepted",
    })
  })

  it("returns unsupported when the native plugin is absent", async () => {
    const unavailable = async () => {
      throw new Error("missing")
    }
    await expect(getMobileCrashCapabilities(unavailable)).resolves.toEqual({ kind: "unsupported" })
    await expect(listMobileCrashReports(unavailable)).resolves.toEqual({ kind: "unsupported" })
  })

  it("returns a stable error outcome when a native call fails", async () => {
    const { loader, plugin } = makeLoader()
    plugin.readPending.mockRejectedValueOnce(new Error("corrupt report"))

    await expect(readMobileCrashReport("incident-1", loader)).resolves.toEqual({
      kind: "error",
      message: "corrupt report",
    })
  })
})
