// Tests the state machine inside `useImportFlow`. We don't drive the file
// picker (that requires a DOM file input + Tauri); we exercise the encryption
// detection, passphrase retry, and apply paths by skipping the picker and
// driving `submitPassphrase` / `applyPreview` directly.

import "fake-indexeddb/auto"
import { renderHook, act } from "@testing-library/react"
import { useImportFlow } from "./use-import-flow"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { buildBackupPackage, serializePackage } from "@/lib/data/build-package"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { rotateBackupKey, getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { pickAndReadFiles } from "@/lib/files/file-bridge"

jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: jest.fn(),
}))

const mockedPickAndReadFiles = pickAndReadFiles as jest.MockedFunction<typeof pickAndReadFiles>

beforeEach(async () => {
  localStorage.clear()
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
})

async function makePlaintextFile(): Promise<string> {
  const pkg = await buildBackupPackage({ includeSessions: false, includeApiKey: false })
  return serializePackage(pkg)
}

async function makeEncryptedFile(passphrase: string): Promise<string> {
  const pkg = await buildBackupPackage({ includeSessions: false, includeApiKey: false })
  const plaintext = serializePackage(pkg)
  const env = await encryptBackupPackage(plaintext, passphrase, {
    version: pkg.manifest.version,
    schemaVersion: pkg.manifest.schemaVersion,
    traceId: pkg.manifest.traceId,
    exportedAt: pkg.manifest.exportedAt,
    appVersion: pkg.manifest.appVersion,
    backend: pkg.manifest.backend,
    encryption: { enabled: true, format: "encrypted-envelope-v1" },
  })
  return JSON.stringify(env)
}

// Drive the dispatch path directly by mocking the shared file picker.
// `pickAndReadFiles` is the only entrypoint useImportFlow uses to read a file,
// so we stub it to return the test payload without involving jsdom's File API.
async function pickFromString(raw: string, hook: { pickFile: () => Promise<void> }) {
  mockedPickAndReadFiles.mockResolvedValueOnce([{ name: "import.cbk", path: "", content: raw }])
  await hook.pickFile()
}

describe("useImportFlow", () => {
  it("plaintext file → preview", async () => {
    const file = await makePlaintextFile()
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    expect(result.current.state.status).toBe("preview")
  })

  it("encrypted file (auto-key) → silent decrypt → preview", async () => {
    const key = (await getDefaultBackupPassphrase())!
    const file = await makeEncryptedFile(key)
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    expect(result.current.state.status).toBe("preview")
  })

  it("encrypted file (custom passphrase) → needsPassphrase → submit succeeds", async () => {
    // Rotate the auto-key so the silent decrypt path can't accidentally match.
    await rotateBackupKey()
    const file = await makeEncryptedFile("special-pass")
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    expect(result.current.state.status).toBe("needsPassphrase")
    await act(async () => {
      await result.current.submitPassphrase("special-pass")
    })
    expect(result.current.state.status).toBe("preview")
  })

  it("wrong passphrase returns to needsPassphrase with lastError", async () => {
    await rotateBackupKey()
    const file = await makeEncryptedFile("right")
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    await act(async () => {
      await result.current.submitPassphrase("wrong")
    })
    expect(result.current.state.status).toBe("needsPassphrase")
    if (result.current.state.status === "needsPassphrase") {
      expect(result.current.state.lastError).toBeTruthy()
    }
  })

  it("invalid JSON → error state", async () => {
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString("not json {", result.current)
    })
    expect(result.current.state.status).toBe("error")
  })

  it("apply transitions preview → applying → done with a summary", async () => {
    const file = await makePlaintextFile()
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    await act(async () => {
      await result.current.applyPreview({
        mergeStrategy: "skip",
        includeSessions: false,
        includeApiKey: false,
      })
    })
    expect(result.current.state.status).toBe("done")
    if (result.current.state.status === "done") {
      expect(result.current.state.summary).toBeDefined()
    }
  })

  it("reset returns to idle", async () => {
    const file = await makePlaintextFile()
    const { result } = renderHook(() => useImportFlow())
    await act(async () => {
      await pickFromString(file, result.current)
    })
    act(() => result.current.reset())
    expect(result.current.state.status).toBe("idle")
  })
})
