// Behavior tests for `useFullBackup`. We don't render it through React — the
// hook's `run` function is plain async and easy to drive directly via
// `result.current.run(...)`, with `act()` wrapping the state transitions.

import "fake-indexeddb/auto"
import { renderHook, act } from "@testing-library/react"
import { useFullBackup } from "./use-full-backup"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { listBackupHistory } from "@/lib/db/backup-history"
import { readStreamPackage } from "@/lib/data/read-stream-package"
import { blobFileStream } from "@/lib/files/file-bridge"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"

const mockExportPortableRetrievalKeys = jest.fn(
  async (_passphrase?: string, _store?: unknown) => []
)

jest.mock("@/lib/data/retrieval-key-backup", () => ({
  ...jest.requireActual("@/lib/data/retrieval-key-backup"),
  exportPortableRetrievalKeys: (passphrase: string, store?: unknown) =>
    mockExportPortableRetrievalKeys(passphrase, store),
}))

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
  mockExportPortableRetrievalKeys.mockClear()
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
        plaintextConfirmed: true,
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

  it("refuses plaintext export without a separate confirmation receipt", async () => {
    const { result } = renderHook(() => useFullBackup())
    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      outcome = await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "plaintext",
      })
    })
    expect(outcome).toEqual({
      ok: false,
      error: "Plaintext backup requires explicit confirmation.",
    })
    expect(mockExportPortableRetrievalKeys).not.toHaveBeenCalled()
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
    expect(mockExportPortableRetrievalKeys).toHaveBeenCalledWith(expect.any(String), undefined)
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
    expect(mockExportPortableRetrievalKeys).toHaveBeenCalledWith("hunter2", undefined)
  })

  it("auto-key streaming payload authenticates and restores through the production reader", async () => {
    let captured: Blob | undefined
    jest.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      captured = blob as Blob
      return "blob:backup"
    })
    const { result } = renderHook(() => useFullBackup())
    await act(async () => {
      const outcome = await result.current.run({
        includeSessions: false,
        includeApiKey: false,
        encryption: "auto-key",
      })
      expect(outcome).toMatchObject({ ok: true, sizeBytes: captured?.size })
    })
    expect(captured).toBeDefined()
    const key = await getDefaultBackupPassphrase()
    const restored = await readStreamPackage(blobFileStream(captured!), key!)
    expect(restored.pkg.payload.settings).toBeDefined()
    expect(restored.pkg.payload.providerProfileStore).toBeDefined()
    await expect(readStreamPackage(blobFileStream(captured!), "wrong")).rejects.toThrow()
  })
})
