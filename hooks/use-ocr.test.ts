import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useOcr } from "./use-ocr"
import { createOcrRegistry } from "@/lib/ocr/registry"
import { DEFAULT_OCR_SETTINGS, type OcrInput, type OcrProvider, type OcrResult } from "@/types/ocr"
import { OcrError } from "@/lib/ocr/errors"
import type { ExtractDeps } from "@/lib/ocr/index"

function makeProvider(
  overrides: Partial<OcrProvider> & {
    impl?: () => Promise<OcrResult>
  } = {}
): OcrProvider {
  return {
    id: overrides.id ?? "mock",
    label: "Mock",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    async extract() {
      if (overrides.impl) return overrides.impl()
      return {
        providerId: overrides.id ?? "mock",
        pages: [{ pageNumber: 1, markdown: "ok", text: "ok" }],
        combinedMarkdown: "ok",
        combinedText: "ok",
        languages: [],
        durationMs: 0,
        cached: false,
      }
    },
  }
}

function makeDeps(provider: OcrProvider): ExtractDeps {
  const registry = createOcrRegistry()
  registry.register(provider)
  return {
    registry,
    settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: provider.id },
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useOcr", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useOcr(makeDeps(makeProvider())))
    expect(result.current.status).toBe("idle")
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("flips to success and surfaces the OcrResult", async () => {
    const { result } = renderHook(() => useOcr(makeDeps(makeProvider())))
    await act(async () => {
      await result.current.run(input)
    })
    await waitFor(() => expect(result.current.status).toBe("success"))
    expect(result.current.result?.providerId).toBe("mock")
  })

  it("captures OcrError code on failure", async () => {
    const provider = makeProvider({
      id: "broken",
      impl: async () => {
        throw new OcrError("rate_limited", "broken", "slow")
      },
    })
    const { result } = renderHook(() => useOcr(makeDeps(provider)))
    await act(async () => {
      await result.current.run(input)
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error?.code).toBe("rate_limited")
  })

  it("falls back to provider_failed on plain errors", async () => {
    const provider = makeProvider({
      id: "boom",
      impl: async () => {
        throw new Error("network down")
      },
    })
    const { result } = renderHook(() => useOcr(makeDeps(provider)))
    await act(async () => {
      await result.current.run(input)
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error?.code).toBe("provider_failed")
  })

  it("reports provider_failed when the deps thunk returns null", async () => {
    const { result } = renderHook(() => useOcr(() => null))
    await act(async () => {
      await result.current.run(input)
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error?.code).toBe("provider_failed")
  })

  it("reset returns the hook to idle", async () => {
    const { result } = renderHook(() => useOcr(makeDeps(makeProvider())))
    await act(async () => {
      await result.current.run(input)
    })
    await act(async () => {
      result.current.reset()
    })
    expect(result.current.status).toBe("idle")
    expect(result.current.result).toBeNull()
  })
})
