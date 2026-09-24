/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useCodexDiscovery } from "./hooks"
import { discoverCodexAuth } from "./discovery"

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("./discovery", () => ({ discoverCodexAuth: jest.fn() }))

it("probes silently on mount and asks for Keychain access only on manual reload", async () => {
  const discover = jest.mocked(discoverCodexAuth)
  discover.mockRejectedValueOnce(new Error("access requires authorization"))
  const { result } = renderHook(() => useCodexDiscovery())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(discover).toHaveBeenCalledWith()
  expect(result.current.error).toBe("access requires authorization")
  discover.mockResolvedValueOnce(null)
  await act(async () => result.current.reload())
  expect(discover).toHaveBeenLastCalledWith(true)
  expect(result.current.error).toBeNull()
})
