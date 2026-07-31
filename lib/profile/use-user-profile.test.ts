/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react"

import type { AppSettings, UserProfile } from "@cognia/agent-config-types"

import { resolveAvatarUrl, resolveDisplayName, useUserProfile } from "./use-user-profile"

interface MockState {
  settings: Partial<AppSettings> | null
  loaded: boolean
  save: jest.Mock
}

jest.mock("@/stores/settings/settings-store", () => {
  const state: MockState = { settings: null, loaded: false, save: jest.fn() }
  const useSettingsStore = (selector: (s: MockState) => unknown) => selector(state)
  useSettingsStore.getState = () => state
  useSettingsStore.__state = state
  return { useSettingsStore }
})

jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: jest.fn(),
}))

import { useSettingsStore } from "@/stores/settings/settings-store"
import { useActiveAnthropicCredential } from "@/lib/subscription/anthropic/hooks"

const mockState = (useSettingsStore as unknown as { __state: MockState }).__state
const mockCredentialHook = useActiveAnthropicCredential as jest.Mock

const setCredential = (email: string | undefined, loading = false) => {
  mockCredentialHook.mockReturnValue({
    activeAccountId: email ? "acc-1" : null,
    credential: email ? { email } : null,
    loading,
    reload: jest.fn(),
    refresh: jest.fn(),
    signOut: jest.fn(),
  })
}

beforeEach(() => {
  mockState.settings = null
  mockState.loaded = false
  mockState.save = jest.fn().mockResolvedValue(undefined)
  setCredential(undefined)
})

describe("resolveDisplayName", () => {
  it("prefers the custom display name", () => {
    expect(resolveDisplayName({ displayName: "Max" }, "someone@example.com")).toBe("Max")
  })

  it("trims the custom name and falls through when blank", () => {
    expect(resolveDisplayName({ displayName: "   " }, "someone@example.com")).toBe("someone")
  })

  it("derives the email prefix when no custom name is set", () => {
    expect(resolveDisplayName({}, "max.qian@example.com")).toBe("max.qian")
    expect(resolveDisplayName(undefined, "max.qian@example.com")).toBe("max.qian")
  })

  it("returns null for a malformed email", () => {
    expect(resolveDisplayName({}, "not-an-email")).toBeNull()
  })

  it("returns null for an empty email prefix", () => {
    expect(resolveDisplayName({}, "@example.com")).toBeNull()
  })

  it("returns null when nothing is available", () => {
    expect(resolveDisplayName(undefined, undefined)).toBeNull()
    expect(resolveDisplayName({}, "")).toBeNull()
  })
})

describe("resolveAvatarUrl", () => {
  it("returns the stored data URL", () => {
    expect(resolveAvatarUrl({ avatarDataUrl: "data:image/webp;base64,AA" })).toBe(
      "data:image/webp;base64,AA"
    )
  })

  it("treats empty string and undefined as unset", () => {
    expect(resolveAvatarUrl({ avatarDataUrl: "" })).toBeNull()
    expect(resolveAvatarUrl({})).toBeNull()
    expect(resolveAvatarUrl(undefined)).toBeNull()
  })
})

describe("useUserProfile", () => {
  it("exposes defaults before the store hydrates", () => {
    const { result } = renderHook(() => useUserProfile())
    expect(result.current.profile).toEqual({})
    expect(result.current.loaded).toBe(false)
    expect(result.current.resolvedDisplayName).toBeNull()
    expect(result.current.resolvedAvatarUrl).toBeNull()
    expect(result.current.email).toBe("")
  })

  it("resolves identity from the stored profile with credential fallback", () => {
    mockState.settings = { profile: { displayName: "Custom Name" } }
    mockState.loaded = true
    setCredential("someone@example.com")
    const { result } = renderHook(() => useUserProfile())
    expect(result.current.resolvedDisplayName).toBe("Custom Name")
    expect(result.current.email).toBe("someone@example.com")
  })

  it("falls back to the credential email prefix without a custom name", () => {
    mockState.settings = { profile: {} }
    mockState.loaded = true
    setCredential("someone@example.com")
    const { result } = renderHook(() => useUserProfile())
    expect(result.current.resolvedDisplayName).toBe("someone")
  })

  it("surfaces credential loading state", () => {
    setCredential(undefined, true)
    const { result } = renderHook(() => useUserProfile())
    expect(result.current.credentialLoading).toBe(true)
  })

  it("save() merges the patch over the CURRENT stored profile and bumps updatedAt", async () => {
    const existing: UserProfile = {
      displayName: "Old",
      bio: "keep me",
      avatarDataUrl: "data:image/webp;base64,AA",
    }
    mockState.settings = { profile: existing }
    mockState.loaded = true

    const { result } = renderHook(() => useUserProfile())
    await act(async () => {
      await result.current.save({ displayName: "New" })
    })

    expect(mockState.save).toHaveBeenCalledTimes(1)
    const patch = mockState.save.mock.calls[0][0] as { profile: UserProfile }
    expect(patch.profile.displayName).toBe("New")
    // Sibling fields survive (read-modify-merge, not blind overwrite).
    expect(patch.profile.bio).toBe("keep me")
    expect(patch.profile.avatarDataUrl).toBe("data:image/webp;base64,AA")
    expect(typeof patch.profile.updatedAt).toBe("number")
  })

  it("save() works when no profile exists yet", async () => {
    mockState.settings = {}
    mockState.loaded = true
    const { result } = renderHook(() => useUserProfile())
    await act(async () => {
      await result.current.save({ bio: "hello" })
    })
    const patch = mockState.save.mock.calls[0][0] as { profile: UserProfile }
    expect(patch.profile.bio).toBe("hello")
  })
})
