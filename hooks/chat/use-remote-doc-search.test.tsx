import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  getDocsProviderByPrefix: jest.fn(),
  isDocsProviderHostSupported: jest.fn(() => true),
}))

import {
  DocsProviderError,
  getDocsProviderByPrefix,
  isDocsProviderHostSupported,
  type DocsProvider,
  type RemoteDocRef,
} from "@/lib/docs-providers"
import {
  DOC_SEARCH_DEBOUNCE_MS,
  DOC_SEARCH_LIMIT,
  useRemoteDocSearch,
} from "./use-remote-doc-search"

const byPrefixMock = getDocsProviderByPrefix as jest.Mock
const hostSupportedMock = isDocsProviderHostSupported as jest.Mock

const HIT: RemoteDocRef = { providerId: "lark", kind: "doc", id: "doxcn1", title: "Spec" }

function provider(overrides: Partial<DocsProvider> = {}): DocsProvider {
  return {
    id: "lark",
    mentionPrefix: "lark:",
    kinds: ["doc"],
    hosts: ["tauri"],
    listAccounts: jest.fn(async () => [{ id: "cai_1", label: "Acme" }]),
    matchRef: jest.fn(() => null),
    search: jest.fn(async () => [HIT]),
    fetch: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  hostSupportedMock.mockReturnValue(true)
})

afterEach(() => {
  jest.useRealTimers()
})

/** Advance past the debounce inside `act` so the pending search actually fires. */
async function flushDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(DOC_SEARCH_DEBOUNCE_MS + 1)
  })
}

describe("useRemoteDocSearch — inactive", () => {
  it("resolves nothing when no namespace is active", () => {
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: null, query: "" }))
    expect(result.current.provider).toBeNull()
    expect(result.current.hostSupported).toBe(false)
    expect(result.current.items).toEqual([])
    expect(byPrefixMock).not.toHaveBeenCalled()
  })

  it("reports an unregistered prefix as no provider", () => {
    byPrefixMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "nope:", query: "" }))
    expect(result.current.provider).toBeNull()
  })
})

describe("useRemoteDocSearch — host gating", () => {
  it("loads no accounts and runs no search on an unsupported host", async () => {
    const p = provider()
    byPrefixMock.mockReturnValue(p)
    hostSupportedMock.mockReturnValue(false)
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "spec" }))
    await flushDebounce()
    expect(result.current.hostSupported).toBe(false)
    expect(p.listAccounts).not.toHaveBeenCalled()
    expect(p.search).not.toHaveBeenCalled()
  })
})

describe("useRemoteDocSearch — accounts", () => {
  it("auto-selects the first account", async () => {
    byPrefixMock.mockReturnValue(provider())
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "" }))
    await waitFor(() => expect(result.current.accountId).toBe("cai_1"))
    expect(result.current.accounts).toEqual([{ id: "cai_1", label: "Acme" }])
  })

  it("honours an explicit account switch", async () => {
    byPrefixMock.mockReturnValue(
      provider({
        listAccounts: jest.fn(async () => [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]),
      })
    )
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "" }))
    await waitFor(() => expect(result.current.accountId).toBe("a"))
    act(() => result.current.setAccountId("b"))
    await waitFor(() => expect(result.current.accountId).toBe("b"))
  })

  it("surfaces an account-listing failure instead of showing an empty list", async () => {
    byPrefixMock.mockReturnValue(
      provider({
        listAccounts: jest.fn(async () => {
          throw new DocsProviderError("notConfigured")
        }),
      })
    )
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "" }))
    await waitFor(() => expect(result.current.error?.code).toBe("notConfigured"))
    expect(result.current.accounts).toEqual([])
  })
})

describe("useRemoteDocSearch — link fast path", () => {
  it("resolves a recognized link with no network call and no account", async () => {
    const p = provider({
      matchRef: jest.fn(() => ({
        kind: "doc" as const,
        id: "doxcn1",
        url: "https://x/docx/doxcn1",
      })),
      listAccounts: jest.fn(async () => []),
    })
    byPrefixMock.mockReturnValue(p)
    const { result } = renderHook(() =>
      useRemoteDocSearch({ namespace: "lark:", query: "https://x/docx/doxcn1" })
    )
    await flushDebounce()
    expect(p.search).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([
      {
        providerId: "lark",
        kind: "doc",
        id: "doxcn1",
        url: "https://x/docx/doxcn1",
        title: "doxcn1",
      },
    ])
    expect(result.current.loading).toBe(false)
  })
})

describe("useRemoteDocSearch — keyword search", () => {
  it("debounces before the query leaves the device", async () => {
    const p = provider()
    byPrefixMock.mockReturnValue(p)
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "spec" }))
    await waitFor(() => expect(result.current.accountId).toBe("cai_1"))
    expect(p.search).not.toHaveBeenCalled()
    await flushDebounce()
    await waitFor(() => expect(result.current.items).toEqual([HIT]))
    expect(p.search).toHaveBeenCalledWith("spec", { accountId: "cai_1", limit: DOC_SEARCH_LIMIT })
  })

  it("runs nothing for an empty query", async () => {
    const p = provider()
    byPrefixMock.mockReturnValue(p)
    renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "   " }))
    await flushDebounce()
    expect(p.search).not.toHaveBeenCalled()
  })

  it("reports a search failure and clears the stale list", async () => {
    const p = provider({
      search: jest.fn(async () => {
        throw new DocsProviderError("notAuthorized", { account: "Acme" })
      }),
    })
    byPrefixMock.mockReturnValue(p)
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "spec" }))
    await waitFor(() => expect(result.current.accountId).toBe("cai_1"))
    await flushDebounce()
    await waitFor(() => expect(result.current.error?.code).toBe("notAuthorized"))
    expect(result.current.error?.params).toEqual({ account: "Acme" })
    expect(result.current.items).toEqual([])
  })

  it("marks a provider without search as link-only rather than broken", async () => {
    byPrefixMock.mockReturnValue(provider({ search: undefined }))
    const { result } = renderHook(() => useRemoteDocSearch({ namespace: "lark:", query: "spec" }))
    await flushDebounce()
    expect(result.current.linkOnly).toBe(true)
    expect(result.current.error).toBeNull()
  })
})
