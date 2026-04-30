// Behavior tests for `useFullBackup`. We don't render it through React — the
// hook's `run` function is plain async and easy to drive directly via
// `result.current.run(...)`, with `act()` wrapping the state transitions.

import "fake-indexeddb/auto"
import { renderHook, act } from "@testing-library/react"
import { useFullBackup } from "./use-full-backup"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { listBackupHistory } from "@/lib/db/backup-history"
import { decryptBackupPackage } from "@/lib/data/crypto"
import { isEncryptedEnvelope } from "@/lib/data/migrate"

// jsdom doesn't expose URL.createObjectURL; mock it for the web download path.
beforeAll(() => {
  if (typeof URL.createObjectURL === "undefined") {
    Object.defineProperty(URL, "createObjectURL", {
      value: jest.fn(() => "blob:mock"),
      configurable: true,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      value: jest.fn(),
      configurable: true,
    })
  }
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
  // We DON'T trigger the web download path during tests — replace anchor.click
  // so it doesn't error, and capture the produced Blob via createObjectURL.
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    value: jest.fn(),
    configurable: true,
  })
})

describe("useFullBackup", () => {
  it("plaintext export records a successful row in backupHistory", async () => {
    const { result } = renderHook(() => useFullBackup())
    type Outcome = Awaited<ReturnType<typeof result.current.run>>
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "plaintext",
      })
    })
    expect(outcome).toMatchObject({ ok: true, canceled: false })
    const history = await listBackupHistory()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      success: true,
      type: "manual",
      encryption: "none",
    })
  })

  it("auto-key export produces a decryptable encrypted envelope", async () => {
    // We can't easily inspect the file body since the web path uses Blob; the
    // round-trip is validated thoroughly elsewhere. Here we just confirm the
    // outcome reports `ok` and the history reflects auto-key.
    const { result } = renderHook(() => useFullBackup())
    type Outcome = Awaited<ReturnType<typeof result.current.run>>
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "auto-key",
      })
    })
    expect(outcome?.ok).toBe(true)
    const history = await listBackupHistory()
    expect(history[0].encryption).toBe("auto-key")
  })

  it("passphrase mode without a passphrase fails with a clear error", async () => {
    const { result } = renderHook(() => useFullBackup())
    type Outcome = Awaited<ReturnType<typeof result.current.run>>
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "passphrase",
        passphrase: "",
      })
    })
    expect(outcome?.ok).toBe(false)
  })

  it("passphrase mode with a passphrase records `passphrase` encryption", async () => {
    const { result } = renderHook(() => useFullBackup())
    await act(async () => {
      await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "passphrase",
        passphrase: "hunter2",
      })
    })
    const history = await listBackupHistory()
    expect(history[0].encryption).toBe("passphrase")
    expect(history[0].success).toBe(true)
  })

  // Sanity: ensure the encrypted envelope produced by auto-key is structurally
  // an EncryptedEnvelopeV1 (we can decrypt it manually by intercepting the
  // serializer). We do this by stubbing Blob to capture the body.
  it("auto-key payload is decryptable round-trip", async () => {
    let captured: string | null = null
    const RealBlob = globalThis.Blob
    class CaptureBlob {
      constructor(parts: BlobPart[]) {
        captured = String(parts[0])
      }
    }
    Object.defineProperty(globalThis, "Blob", { value: CaptureBlob, configurable: true })
    try {
      const { result } = renderHook(() => useFullBackup())
      await act(async () => {
        await result.current.run({
          includeSessions: false,
          includeApiKey: false,
          encryption: "auto-key",
        })
      })
    } finally {
      Object.defineProperty(globalThis, "Blob", { value: RealBlob, configurable: true })
    }
    expect(captured).toBeTruthy()
    const env = JSON.parse(captured!)
    expect(isEncryptedEnvelope(env)).toBe(true)
    const { getDefaultBackupPassphrase } = await import("@/lib/data/backup-key")
    const key = await getDefaultBackupPassphrase()
    expect(key).toBeTruthy()
    const plaintext = await decryptBackupPackage(env, key!)
    const pkg = JSON.parse(plaintext)
    expect(pkg.version).toBe("3.0")
    expect(pkg.manifest.schemaVersion).toBe(3)
  })
})
