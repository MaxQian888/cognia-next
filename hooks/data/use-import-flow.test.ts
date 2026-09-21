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
import { createBackupStream } from "@/lib/data/stream-format"
import { pickStreamFiles } from "@/lib/files/file-bridge"

const mockApplyBackupPackage = jest.fn(async (_pkg?: unknown, _options?: unknown) => ({
  added: {},
  overwritten: {},
  skipped: {},
  builtInsSkipped: {},
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickStreamFiles: jest.fn(),
}))
jest.mock("@/lib/data/apply-package", () => ({
  applyBackupPackage: (pkg: unknown, options: unknown) => mockApplyBackupPackage(pkg, options),
}))

const mockedPickStreamFiles = pickStreamFiles as jest.MockedFunction<typeof pickStreamFiles>

beforeEach(async () => {
  mockApplyBackupPackage.mockClear()
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
// `pickStreamFiles` is the only entrypoint useImportFlow uses to read a file,
// so we stub it to return the test payload without involving jsdom's File API.
async function pickFromString(raw: string, hook: { pickFile: () => Promise<void> }) {
  mockedPickStreamFiles.mockResolvedValueOnce([
    {
      name: "import.cbk",
      path: "",
      stream: async function* () {
        yield new TextEncoder().encode(raw)
      },
    },
  ])
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
    await act(async () => {
      await result.current.applyPreview({
        mergeStrategy: "skip",
        includeSessions: false,
        includeApiKey: false,
      })
    })
    expect(mockApplyBackupPackage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ retrievalDekPassphrase: "special-pass" })
    )
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

it("v4 encrypted file retries its source and previews all sections without a legacy text buffer", async () => {
  await rotateBackupKey()
  const source = () =>
    createBackupStream({
      manifest: {
        traceId: "stream-import",
        exportedAt: "2026-09-21T00:00:00Z",
        appVersion: "test",
        backend: "web-dexie",
        sourceSchemaVersion: 3,
      },
      encryption: { passphrase: "stream-password" },
      sections: (async function* () {
        yield { section: "settings", rows: [{ theme: "dark" }] }
        yield { section: "characters", rows: [{ id: "restored-character" }] }
      })(),
    })
  mockedPickStreamFiles.mockResolvedValueOnce([{ name: "stream.cbk", path: "", stream: source }])
  const { result } = renderHook(() => useImportFlow())
  await act(async () => {
    await result.current.pickFile()
  })
  expect(result.current.state.status).toBe("needsPassphrase")
  await act(async () => {
    await result.current.submitPassphrase("wrong")
  })
  expect(result.current.state.status).toBe("needsPassphrase")
  await act(async () => {
    await result.current.submitPassphrase("stream-password")
  })
  expect(result.current.state).toMatchObject({
    status: "preview",
    pkg: { payload: { settings: { theme: "dark" }, characters: [{ id: "restored-character" }] } },
  })
})

async function smallStreamRecords() {
  const records: Uint8Array[] = []
  for await (const bytes of createBackupStream({
    manifest: {
      traceId: "chunked",
      exportedAt: "2026-09-21T00:00:00Z",
      appVersion: "test",
      backend: "web-dexie",
      sourceSchemaVersion: 3,
    },
    sections: (async function* () {
      yield { section: "characters", rows: [{ id: "old-stream" }] }
    })(),
  }))
    records.push(bytes)
  return records
}

it("detects a stream header split across short reads", async () => {
  const records = await smallStreamRecords()
  mockedPickStreamFiles.mockResolvedValueOnce([
    {
      name: "short.cbk",
      path: "",
      stream: async function* () {
        for (const record of records)
          for (let offset = 0; offset < record.length; offset += 7)
            yield record.subarray(offset, offset + 7)
      },
    },
  ])
  const { result } = renderHook(() => useImportFlow())
  await act(async () => {
    await result.current.pickFile()
  })
  expect(result.current.state).toMatchObject({
    status: "preview",
    pkg: { payload: { characters: [{ id: "old-stream" }] } },
  })
})

it.each(["reset", "new-file"])(
  "prevents an in-flight stream from replacing state after %s",
  async (action) => {
    const records = await smallStreamRecords()
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    let opens = 0
    let closed = 0
    mockedPickStreamFiles.mockResolvedValueOnce([
      {
        name: "old.cbk",
        path: "",
        stream: async function* () {
          opens += 1
          try {
            yield records[0]
            if (opens === 2) {
              started()
              await blocked
            }
            yield* records.slice(1)
          } finally {
            closed += 1
          }
        },
      },
    ])
    const { result } = renderHook(() => useImportFlow())
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.pickFile()
      await reading
    })
    if (action === "reset") act(() => result.current.reset())
    else {
      const file = await makePlaintextFile()
      await act(async () => {
        await pickFromString(file, result.current)
      })
    }
    await act(async () => {
      release()
      await pending
    })
    expect(closed).toBe(2)
    if (action === "reset") expect(result.current.state.status).toBe("idle")
    else {
      expect(result.current.state.status).toBe("preview")
      expect(result.current.state).not.toMatchObject({
        pkg: { payload: { characters: [{ id: "old-stream" }] } },
      })
    }
  }
)
