/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsKeyringList: jest.fn(),
  connectorsKeyringSet: jest.fn(),
  connectorsKeyringDelete: jest.fn(),
}))

jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: jest.fn(() => true),
}))

import {
  connectorsKeyringDelete,
  connectorsKeyringGet,
  connectorsKeyringList,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { useCapability } from "@/hooks/use-host-profile"
import { isCredentialReadRefused, useAdapterCredentials } from "./use-adapter-credentials"

const mockGet = connectorsKeyringGet as jest.Mock
const mockList = connectorsKeyringList as jest.Mock
const mockSet = connectorsKeyringSet as jest.Mock
const mockDelete = connectorsKeyringDelete as jest.Mock
const mockCapability = useCapability as jest.Mock

/** Stored keyring contents for the current test. */
function stored(values: Record<string, string | null>): void {
  mockGet.mockImplementation(async (_id: string, name: string) => values[name] ?? null)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCapability.mockReturnValue(true)
  stored({})
  mockList.mockResolvedValue([])
})

function renderCreds(
  overrides: Partial<Parameters<typeof useAdapterCredentials>[0]> = {}
): ReturnType<typeof renderHook<ReturnType<typeof useAdapterCredentials>, unknown>> {
  return renderHook(() =>
    useAdapterCredentials({
      adapterId: "adp_1",
      accounts: ["appKey", "appSecret"],
      ...overrides,
    })
  )
}

describe("useAdapterCredentials", () => {
  it("reads nothing for a create dialog", async () => {
    const { result } = renderCreds({ adapterId: null })
    expect(result.current.status("appSecret")).toBe("new")
    expect(result.current.loading).toBe(false)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("prefills the stored value and reports it as loaded", async () => {
    stored({ appKey: "key-1", appSecret: "shh" })
    const { result } = renderCreds()

    expect(result.current.loading).toBe(true)
    expect(result.current.status("appSecret")).toBe("loading")

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value("appSecret")).toBe("shh")
    expect(result.current.status("appSecret")).toBe("loaded")
    expect(result.current.value("appKey")).toBe("key-1")
  })

  it("separates 'never stored' from 'stored but unreadable'", async () => {
    mockGet.mockImplementation(async (_id: string, name: string) => {
      if (name === "appKey") return null
      throw new Error("403 command_transport_forbidden")
    })
    const { result } = renderCreds()

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status("appKey")).toBe("unset")
    expect(result.current.status("appSecret")).toBe("stored")
    expect(result.current.refused).toBe(true)
  })

  it("reports an unexpected failure as an error, not as a refusal", async () => {
    mockGet.mockRejectedValue(new Error("keyring backend unavailable"))
    const { result } = renderCreds()

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status("appSecret")).toBe("error")
    expect(result.current.refused).toBe(false)
  })

  it("does not probe at all when the host has no connector runtime", async () => {
    mockCapability.mockReturnValue(false)
    const { result } = renderCreds()

    expect(result.current.status("appSecret")).toBe("stored")
    expect(result.current.loading).toBe(false)
    expect(mockGet).not.toHaveBeenCalled()
  })

  describe("write intents", () => {
    it("treats an untouched field as unchanged", async () => {
      stored({ appSecret: "shh" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.intent("appSecret")).toBe("unchanged")
      expect(result.current.dirty).toBe(false)
    })

    it("treats retyping the same value as unchanged", async () => {
      stored({ appSecret: "shh" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => result.current.set("appSecret", "shh"))
      expect(result.current.intent("appSecret")).toBe("unchanged")
      expect(result.current.dirty).toBe(false)
    })

    it("treats a different value as a write", async () => {
      stored({ appSecret: "shh" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => result.current.set("appSecret", "louder"))
      expect(result.current.intent("appSecret")).toBe("set")
      expect(result.current.dirty).toBe(true)
    })

    it("treats emptying a READ-BACK field as a deliberate clear", async () => {
      stored({ appSecret: "shh" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => result.current.set("appSecret", ""))
      expect(result.current.intent("appSecret")).toBe("clear")
    })

    // The safety property: on a shell that could not read the stored value, a
    // blank box must keep meaning "leave it alone".
    it("never clears a field whose stored value could not be read", async () => {
      mockGet.mockRejectedValue(new Error("remote_control_forbidden"))
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => result.current.set("appSecret", "typed"))
      act(() => result.current.set("appSecret", ""))
      expect(result.current.intent("appSecret")).toBe("unchanged")
      expect(result.current.dirty).toBe(false)
    })
  })

  describe("missingRequired", () => {
    it("flags a blank required field on a create dialog", () => {
      const { result } = renderCreds({ adapterId: null })
      expect(result.current.missingRequired(["appKey", "appSecret"])).toEqual([
        "appKey",
        "appSecret",
      ])
      act(() => result.current.set("appKey", "k"))
      expect(result.current.missingRequired(["appKey", "appSecret"])).toEqual(["appSecret"])
    })

    it("flags a stored value the operator emptied", async () => {
      stored({ appKey: "k", appSecret: "s" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.missingRequired(["appSecret"])).toEqual([])
      act(() => result.current.set("appSecret", ""))
      expect(result.current.missingRequired(["appSecret"])).toEqual(["appSecret"])
    })

    it("flags a required field that is genuinely unset on an existing adapter", async () => {
      stored({ appKey: "k" })
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.status("appSecret")).toBe("unset")
      expect(result.current.missingRequired(["appKey", "appSecret"])).toEqual(["appSecret"])

      act(() => result.current.set("appSecret", "now set"))
      expect(result.current.missingRequired(["appSecret"])).toEqual([])
    })

    it("does not flag a value it merely could not read", async () => {
      mockGet.mockRejectedValue(new Error("command_transport_forbidden"))
      const { result } = renderCreds()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.missingRequired(["appKey", "appSecret"])).toEqual([])
    })
  })

  it("persists sets and clears, and skips everything unchanged", async () => {
    stored({ appKey: "key-1", appSecret: "shh" })
    const { result } = renderCreds()
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.set("appKey", "  key-2  "))
    act(() => result.current.set("appSecret", ""))
    await act(async () => {
      await result.current.persist("adp_1")
    })

    expect(mockSet).toHaveBeenCalledTimes(1)
    expect(mockSet).toHaveBeenCalledWith("adp_1", "appKey", "key-2")
    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(mockDelete).toHaveBeenCalledWith("adp_1", "appSecret")
  })

  it("writes a create dialog's values under the id it is handed", async () => {
    const { result } = renderCreds({ adapterId: null })
    act(() => result.current.set("appSecret", "fresh"))
    await act(async () => {
      await result.current.persist("adp_new")
    })
    expect(mockSet).toHaveBeenCalledWith("adp_new", "appSecret", "fresh")
  })

  it("probes derived tokens for presence and never reads them back", async () => {
    stored({ appSecret: "shh" })
    mockList.mockResolvedValue(["userToken"])
    const { result } = renderCreds({ derivedAccounts: ["userToken", "userRefreshToken"] })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockList).toHaveBeenCalledWith("adp_1", ["userToken", "userRefreshToken"])
    expect(result.current.derivedPresence("userToken")).toBe(true)
    expect(result.current.derivedPresence("userRefreshToken")).toBe(false)
    expect(mockGet).not.toHaveBeenCalledWith("adp_1", "userToken")
  })

  it("leaves derived presence unknown when the probe itself fails", async () => {
    mockList.mockRejectedValue(new Error("nope"))
    const { result } = renderCreds({ derivedAccounts: ["userToken"] })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.derivedPresence("userToken")).toBeUndefined()
  })

  it("re-reads on retry", async () => {
    mockGet.mockRejectedValue(new Error("boom"))
    const { result } = renderCreds()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockGet).toHaveBeenCalledTimes(2)

    stored({ appKey: "k", appSecret: "s" })
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status("appSecret")).toBe("loaded"))
    expect(result.current.value("appSecret")).toBe("s")
  })

  it("drops the previous adapter's edits when the dialog reopens on another", async () => {
    stored({ appKey: "a", appSecret: "b" })
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useAdapterCredentials({ adapterId: id, accounts: ["appKey", "appSecret"] }),
      { initialProps: { id: "adp_1" } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.set("appSecret", "typed into the first one"))

    rerender({ id: "adp_2" })
    expect(result.current.value("appSecret")).toBe("")
    expect(result.current.status("appSecret")).toBe("loading")
    expect(result.current.dirty).toBe(false)

    // Let the second adapter's read land so it cannot settle after teardown.
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value("appSecret")).toBe("b")
  })

  it("costs nothing while the dialog is closed", async () => {
    renderCreds({ enabled: false })
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe("isCredentialReadRefused", () => {
  it.each([
    "403 command_transport_forbidden",
    "remote_control_forbidden",
    "missing_capability: host.admin",
    "REMOTE_SCOPE_DENIED",
    "REMOTE_CONSENT_REQUIRED",
    "this command requires the headless service token",
    "window.__TAURI_INTERNALS__ is undefined",
    "tauri-only command from web mode: connectors_keyring_get",
  ])("classifies %s as a refusal", (message) => {
    expect(isCredentialReadRefused(new Error(message))).toBe(true)
  })

  it.each(["keyring backend unavailable", "network error", ""])(
    "classifies %s as a fault",
    (message) => {
      expect(isCredentialReadRefused(new Error(message))).toBe(false)
    }
  )

  it("survives a non-Error rejection", () => {
    expect(isCredentialReadRefused(undefined)).toBe(false)
    expect(isCredentialReadRefused("remote_control_forbidden")).toBe(true)
  })
})
