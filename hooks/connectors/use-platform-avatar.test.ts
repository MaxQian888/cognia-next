/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePlatformAvatar } from "./use-platform-avatar"
import { resolvePlatformAvatar, type PlatformAvatarTarget } from "@/lib/connectors/platform-avatar"
import {
  __resetCredentialsEventsForTesting,
  emitCredentialsRotated,
} from "@/lib/connectors/credentials-events"

jest.mock("@/lib/connectors/platform-avatar", () => ({
  resolvePlatformAvatar: jest.fn(),
  inlineAvatarUrl: (value: unknown) =>
    typeof value === "string" && value.startsWith("data:image/png;base64,") ? value : undefined,
  AVATAR_TTL_MS: 60000,
  AVATAR_RETRY_MS: 30000,
  avatarConfigKey: (row: { settings?: unknown }) => JSON.stringify(row.settings ?? {}),
}))
let mockAdapter: { settings: Record<string, string> } | undefined = { settings: {} }
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockAdapter }))
let mockScope = "account-a"
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: mockScope }) }))
const target: PlatformAvatarTarget = {
  platform: "onebot",
  adapterId: "a",
  kind: "user",
  remoteId: "123",
}
beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  __resetCredentialsEventsForTesting()
  mockScope = "account-a"
  mockAdapter = { settings: {} }
})

it("does no lookup without an IM identity and immediately accepts inline image bytes", () => {
  const { result, rerender } = renderHook(({ value }) => usePlatformAvatar(value), {
    initialProps: { value: null as PlatformAvatarTarget | null },
  })
  expect(result.current).toBeUndefined()
  expect(resolvePlatformAvatar).not.toHaveBeenCalled()
  rerender({ value: { ...target, avatarUrl: "data:image/png;base64,AAA" } })
  expect(result.current).toBe("data:image/png;base64,AAA")
  expect(resolvePlatformAvatar).not.toHaveBeenCalled()
})

it("does not flash the previous person's image or accept an obsolete late result", async () => {
  let resolveOld!: (value: string) => void
  jest
    .mocked(resolvePlatformAvatar)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    .mockResolvedValueOnce("data:image/png;base64,NEW")
  const { result, rerender } = renderHook(({ value }) => usePlatformAvatar(value), {
    initialProps: { value: target },
  })
  rerender({ value: { ...target, remoteId: "456" } })
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toBe("data:image/png;base64,NEW"))
  await act(async () => {
    resolveOld("data:image/png;base64,OLD")
  })
  expect(result.current).toBe("data:image/png;base64,NEW")
})

it("hides a previous account's result immediately after scope change", async () => {
  jest
    .mocked(resolvePlatformAvatar)
    .mockResolvedValueOnce("data:image/png;base64,OLD")
    .mockResolvedValueOnce("data:image/png;base64,NEW")
  const { result, rerender } = renderHook(() => usePlatformAvatar(target))
  await waitFor(() => expect(result.current).toContain("OLD"))
  mockScope = "account-b"
  rerender()
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toContain("NEW"))
})

it("contains unavailable profile or cache requests without throwing into the transcript", async () => {
  jest.mocked(resolvePlatformAvatar).mockRejectedValueOnce(new Error("unavailable"))
  const { result } = renderHook(() => usePlatformAvatar(target))
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current).toBeUndefined()
})

it("does not query an old target from a new account when a refresh timer fires before rerender", async () => {
  jest.useFakeTimers()
  try {
    jest.mocked(resolvePlatformAvatar).mockResolvedValue(undefined)
    const { unmount } = renderHook(() => usePlatformAvatar(target))
    await act(async () => {
      await Promise.resolve()
    })
    expect(resolvePlatformAvatar).toHaveBeenCalledTimes(1)
    mockScope = "account-b"
    await act(async () => {
      jest.advanceTimersByTime(30000)
    })
    expect(resolvePlatformAvatar).toHaveBeenCalledTimes(1)
    unmount()
  } finally {
    jest.useRealTimers()
  }
})

it("drops the old portrait on credentials/config changes or adapter deletion", async () => {
  jest.mocked(resolvePlatformAvatar).mockResolvedValue("data:image/png;base64,IMAGE")
  const { result, rerender } = renderHook(() => usePlatformAvatar(target))
  await waitFor(() => expect(result.current).toContain("IMAGE"))
  act(() => {
    emitCredentialsRotated(target.adapterId)
  })
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toContain("IMAGE"))
  mockAdapter = { settings: { homeserver: "new-server" } }
  rerender()
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toContain("IMAGE"))
  mockAdapter = undefined
  rerender()
  expect(result.current).toBeUndefined()
})

it("resynchronizes and refreshes when storage recovers during a profile request", async () => {
  localStorage.setItem("cognia:connectors:credentials-revision:a", crypto.randomUUID())
  const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  let resolveOld!: (value: string) => void
  jest
    .mocked(resolvePlatformAvatar)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    .mockResolvedValueOnce("data:image/png;base64,RECOVERED")
  try {
    emitCredentialsRotated(target.adapterId)
    const { result, unmount } = renderHook(() => usePlatformAvatar(target))
    expect(resolvePlatformAvatar).toHaveBeenCalledTimes(1)
    get.mockRestore()
    set.mockRestore()
    await act(async () => {
      resolveOld("data:image/png;base64,OBSOLETE")
    })
    await waitFor(() => expect(result.current).toBe("data:image/png;base64,RECOVERED"))
    expect(resolvePlatformAvatar).toHaveBeenCalledTimes(2)
    unmount()
  } finally {
    get.mockRestore()
    set.mockRestore()
  }
})
