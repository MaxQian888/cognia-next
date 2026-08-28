import {
  ExternalAgentLifecycleError,
  type ExternalAgentRuntimeReceipt,
} from "@/types/agent/external-agent-lifecycle"

import { findRuntimeById } from "../runtime-catalog"
import {
  PROBE_COMMAND,
  RECEIPT_STORE_KEY,
  createNativeProbe,
  createNativeReceiptStore,
  createNativeRuntimeHost,
  unavailableProviderHost,
  type NativeRuntimeHostDependencies,
  type NativeVersionProbe,
} from "./native-runtime-host"

// ---------------------------------------------------------------------------

function memoryPrefs(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    store,
    getPref: async <T>(key: string) => (store.get(key) as T) ?? null,
    setPref: async <T>(key: string, value: T) => {
      store.set(key, value)
    },
  }
}

/** A pref store that accepts writes and drops them, like `setPref` off-Tauri. */
function silentlyDroppingPrefs() {
  return {
    getPref: async <T>() => null as T | null,
    setPref: async () => {},
  }
}

function receipt(overrides: Partial<ExternalAgentRuntimeReceipt> = {}) {
  return {
    receiptId: "codex@1.0.0+npm@2026-01-01T00:00:00.000Z",
    runtimeId: "codex-app-server",
    version: "1.0.0",
    provider: "npm",
    providerVersion: "10.0.0",
    source: "@openai/codex@1.0.0",
    installRoot: "/root/codex/current",
    entrypoint: "/root/codex/current/bin/codex",
    treeDigest: "a".repeat(64),
    installedAt: "2026-01-01T00:00:00.000Z",
    health: { healthy: true, checkedAt: "2026-01-01T00:00:00.000Z", findings: [] },
    ...overrides,
  } as ExternalAgentRuntimeReceipt
}

function deps(overrides: Partial<NativeRuntimeHostDependencies> = {}) {
  const prefs = memoryPrefs()
  return {
    invoke: jest.fn(async () => ({}) as never),
    getPref: prefs.getPref,
    setPref: prefs.setPref,
    platformKey: "darwin-arm64",
    now: () => new Date("2026-02-02T00:00:00.000Z"),
    ...overrides,
  } satisfies NativeRuntimeHostDependencies
}

// --- receipts --------------------------------------------------------------

describe("createNativeReceiptStore", () => {
  it("round-trips a receipt under the host-local key", async () => {
    const prefs = memoryPrefs()
    const store = createNativeReceiptStore(prefs)

    await store.save(receipt())
    expect(prefs.store.has(RECEIPT_STORE_KEY)).toBe(true)
    expect(await store.load("codex-app-server")).toEqual(receipt())
  })

  it("returns null for a runtime with no receipt", async () => {
    expect(await createNativeReceiptStore(memoryPrefs()).load("codex-app-server")).toBeNull()
  })

  it("keeps other runtimes' receipts when one is saved", async () => {
    const store = createNativeReceiptStore(memoryPrefs())
    await store.save(receipt())
    await store.save(receipt({ runtimeId: "droid", receiptId: "droid@2" }))

    expect(await store.load("codex-app-server")).not.toBeNull()
    expect((await store.load("droid"))?.receiptId).toBe("droid@2")
  })

  it("throws when the write silently does not persist", async () => {
    // `setPref` no-ops outside Tauri and swallows its own errors. A receipt
    // that vanishes would make the next inspect treat a managed tree as
    // unowned and lose the rollback slot, so the failure has to surface.
    const store = createNativeReceiptStore(silentlyDroppingPrefs())
    await expect(store.save(receipt())).rejects.toThrow(ExternalAgentLifecycleError)
    await expect(store.save(receipt())).rejects.toThrow(/did not persist/)
  })

  it("deletes a receipt and tolerates deleting one that is not there", async () => {
    const prefs = memoryPrefs()
    const store = createNativeReceiptStore(prefs)
    await store.save(receipt())

    await store.delete("codex-app-server")
    expect(await store.load("codex-app-server")).toBeNull()
    await expect(store.delete("codex-app-server")).resolves.toBeUndefined()
  })

  it("throws when a delete does not take", async () => {
    const store = createNativeReceiptStore({
      getPref: async <T>() => ({ droid: receipt({ runtimeId: "droid" }) }) as T,
      setPref: async () => {},
    })
    await expect(store.delete("droid")).rejects.toThrow(/could not be removed/)
  })

  it("ignores a corrupted store value instead of crashing the host", async () => {
    const store = createNativeReceiptStore({
      getPref: async <T>() => "not-an-object" as T,
      setPref: async () => {},
    })
    expect(await store.load("codex-app-server")).toBeNull()
  })
})

// --- probe -----------------------------------------------------------------

describe("createNativeProbe", () => {
  const entry = findRuntimeById("codex-app-server")!

  it("sends only the runtime id, never a command line", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      calls.push({ name, args })
      return { output: "codex 1.2.3" } as T
    }

    await createNativeProbe({ invoke })(entry, null)

    // The whole point of the host-side catalog lookup: nothing executable
    // crosses the boundary, so this can never widen into arbitrary exec.
    expect(calls).toEqual([{ name: PROBE_COMMAND, args: { runtimeId: "codex-app-server" } }])
  })

  it("maps the host's observation onto the probe contract", async () => {
    const probe: NativeVersionProbe = {
      output: "codex 1.2.3",
      executablePath: "/usr/local/bin/codex",
      executableDigest: "b".repeat(64),
      exitCode: 0,
    }
    const invoke = jest.fn(async () => probe as never)

    expect(await createNativeProbe({ invoke })(entry, null)).toEqual({
      output: "codex 1.2.3",
      executablePath: "/usr/local/bin/codex",
      executableDigest: "b".repeat(64),
    })
  })

  it("turns a null output into an absent one, so it reads as missing", async () => {
    const invoke = jest.fn(async () => ({ output: null, detail: "not on PATH" }) as never)
    expect(await createNativeProbe({ invoke })(entry, null)).toEqual({
      output: undefined,
      executablePath: undefined,
      executableDigest: undefined,
    })
  })

  it("reports an unreadable version, not a missing runtime, when the call fails", async () => {
    // An older host without the command, or a dropped transport, says nothing
    // about whether the runtime is installed. `output: undefined` would assert
    // that it is not.
    const invoke = jest.fn(async () => {
      throw new Error("unsupported external-agent command")
    })
    expect(await createNativeProbe({ invoke })(entry, null)).toEqual({ output: "" })
  })
})

// --- provider host ---------------------------------------------------------

describe("unavailableProviderHost", () => {
  it("answers the two questions it can answer truthfully", () => {
    const now = () => new Date("2026-03-03T00:00:00.000Z")
    const host = unavailableProviderHost("linux-x64", now)

    expect(host.platformKey()).toBe("linux-x64")
    expect(host.now().toISOString()).toBe("2026-03-03T00:00:00.000Z")
    expect(host.join("a", "b", "c")).toBe("a/b/c")
  })

  it("refuses every byte-moving operation with a typed, explained error", async () => {
    const host = unavailableProviderHost("darwin-arm64")
    const operations: Array<[string, () => Promise<unknown>]> = [
      ["exists", () => host.exists("/x")],
      ["mkdirp", () => host.mkdirp("/x")],
      ["removeDir", () => host.removeDir("/x")],
      ["rename", () => host.rename("/x", "/y")],
      ["writeFile", () => host.writeFile("/x", "y")],
      ["readFile", () => host.readFile("/x")],
      ["hashFile", () => host.hashFile("/x")],
      ["hashTree", () => host.hashTree("/x")],
      ["exec", () => host.exec("npm", ["ci"])],
      ["download", () => host.download("https://x", "/y")],
      ["extract", () => host.extract("/x", "/y", "tar.gz")],
    ]

    const wrong: string[] = []
    for (const [name, call] of operations) {
      try {
        await call()
        wrong.push(`${name}: resolved instead of refusing`)
      } catch (error) {
        if (!(error instanceof ExternalAgentLifecycleError)) {
          wrong.push(`${name}: threw ${String(error)}`)
        } else if (error.code !== "platform_unsupported") {
          wrong.push(`${name}: refused with ${error.code}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

// --- assembly --------------------------------------------------------------

describe("createNativeRuntimeHost", () => {
  it("certifies the version the host reports", async () => {
    const host = createNativeRuntimeHost(
      deps({ invoke: jest.fn(async () => ({ output: "codex-cli 1.2.3" }) as never) })
    )

    const { assessment } = await host.inspect("codex-app-server")
    // `codex-app-server` now catalogues `supportedRange: ">=0.149.0"`, which
    // 1.2.3 satisfies, but only the versions in `certifiedVersions` pass
    // outright — anything else still needs one explicit consent.
    expect(assessment.detectedVersion).toBe("1.2.3")
    expect(assessment.verdict).toBe("supported-uncertified")
    expect(assessment.checkedAt).toBe("2026-02-02T00:00:00.000Z")
  })

  it("certifies the Codex version the adapter was actually verified against", async () => {
    const host = createNativeRuntimeHost(
      deps({ invoke: jest.fn(async () => ({ output: "codex-cli 0.150.1" }) as never) })
    )

    const { assessment } = await host.inspect("codex-app-server")
    expect(assessment.detectedVersion).toBe("0.150.1")
    expect(assessment.verdict).toBe("certified")
  })

  it("refuses a Codex older than the wire contract the adapter speaks", async () => {
    // Below 0.149 there is no `permissions` profile field, `thread/resume` does
    // not restore the thread's own policy, and `thread/fork` takes none of it —
    // so the adapter's resume/fork semantics silently do not apply.
    const host = createNativeRuntimeHost(
      deps({ invoke: jest.fn(async () => ({ output: "codex-cli 0.144.4" }) as never) })
    )

    const { assessment } = await host.inspect("codex-app-server")
    expect(assessment.verdict).toBe("unsupported")
    expect(assessment.blockingCode).toBe("version_unsupported")
  })

  it("reports a runtime that is not installed as missing", async () => {
    const host = createNativeRuntimeHost(
      deps({ invoke: jest.fn(async () => ({ output: null }) as never) })
    )

    const { assessment } = await host.inspect("droid")
    expect(assessment.verdict).toBe("missing")
    expect(assessment.blockingCode).toBe("runtime_missing")
  })

  it("reports unreadable output as unparseable, not as missing", async () => {
    const host = createNativeRuntimeHost(
      deps({ invoke: jest.fn(async () => ({ output: "usage: droid …" }) as never) })
    )

    const { assessment } = await host.inspect("droid")
    expect(assessment.verdict).toBe("unparseable")
  })

  it("does not probe a remote runtime at all", async () => {
    const invoke = jest.fn(async () => ({}) as never)
    const host = createNativeRuntimeHost(deps({ invoke }))

    const { assessment } = await host.inspect("opencode-remote")
    expect(assessment.verdict).toBe("certified")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("refuses to install, update, roll back or uninstall, each for its real reason", async () => {
    // The reasons differ, and the difference is the point: two of these stop
    // before they ever reach the host, because the catalog approves no
    // distribution to install. Only the operation that would actually have
    // touched the disk reports the missing host.
    const host = createNativeRuntimeHost(deps())
    const codes: Record<string, string> = {}

    for (const [name, call] of [
      ["install", () => host.install("deepseek-harness")],
      ["update", () => host.update("deepseek-harness", "1.0.0")],
      ["rollback", () => host.rollback("deepseek-harness")],
      ["uninstall", () => host.uninstall("deepseek-harness")],
    ] as Array<[string, () => Promise<unknown>]>) {
      try {
        await call()
        codes[name] = "resolved"
      } catch (error) {
        codes[name] =
          error instanceof ExternalAgentLifecycleError ? error.code : `threw ${String(error)}`
      }
    }

    expect(codes).toEqual({
      install: "runtime_missing",
      update: "runtime_missing",
      rollback: "runtime_missing",
      uninstall: "platform_unsupported",
    })
  })

  it('does not answer "up to date" for a runtime it cannot check', async () => {
    // No shipped runtime publishes an update channel yet, so every one of them
    // legitimately reports "nothing to check".
    const host = createNativeRuntimeHost(deps())
    await expect(host.checkForUpdate("codex-app-server")).resolves.toBeNull()
  })

  it("surfaces a stored receipt alongside the assessment", async () => {
    const prefs = memoryPrefs()
    await createNativeReceiptStore(prefs).save(receipt())
    const host = createNativeRuntimeHost(
      deps({
        ...prefs,
        invoke: jest.fn(async () => ({ output: "codex 1.0.0" }) as never),
      })
    )

    // Hashing the installed tree is what a real managed host would do; this one
    // cannot, and `inspect` treats that as "cannot verify" rather than
    // "tampered", so the receipt still comes back.
    const result = await host.inspect("codex-app-server")
    expect(result.receipt?.receiptId).toBe(receipt().receiptId)
  })
})
