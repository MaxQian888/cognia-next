const mockCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))
jest.mock("@/lib/db/browser-profiles", () => ({ deleteBrowserProfile: jest.fn() }))

import { deleteBrowserProfile } from "@/lib/db/browser-profiles"
import {
  RemoteProfileDeleteError,
  deleteRemoteBrowserProfile,
  remoteProfileDeleteFailure,
} from "./remote-profiles"

const forget = deleteBrowserProfile as jest.Mock

beforeEach(() => {
  mockCall.mockReset().mockResolvedValue({ deleted: true })
  forget.mockReset().mockResolvedValue(undefined)
})

it("erases the runtime's copy before forgetting the profile here", async () => {
  const order: string[] = []
  mockCall.mockImplementation(async () => order.push("runtime"))
  forget.mockImplementation(async () => order.push("local"))

  await deleteRemoteBrowserProfile("workspace-1", "profile-1")

  expect(mockCall).toHaveBeenCalledWith("browser_profile_delete", {
    workspaceId: "workspace-1",
    profileId: "profile-1",
  })
  expect(forget).toHaveBeenCalledWith("profile-1")
  expect(order).toEqual(["runtime", "local"])
})

// Forgetting the row after a failed erase is exactly the orphan this exists to
// prevent: the data would stay on the server with nothing pointing at it.
it("keeps the profile listed when the runtime refuses", async () => {
  mockCall.mockRejectedValue(new Error("browser_profile_in_use: browser profile is in use"))
  const failure = deleteRemoteBrowserProfile("workspace-1", "profile-1")
  await expect(failure).rejects.toBeInstanceOf(RemoteProfileDeleteError)
  await expect(failure).rejects.toMatchObject({ reason: "in-use" })
  expect(forget).not.toHaveBeenCalled()
})

describe("remoteProfileDeleteFailure", () => {
  it.each([
    ["browser_profile_in_use", "in-use"],
    ["browser_disabled: remote browser server gate is disabled", "unreachable"],
    ["remote browser support is not compiled", "unreachable"],
    ["browser_runtime_unavailable", "unreachable"],
    ["something else", "failed"],
  ])("reads %s as %s", (message, reason) => {
    expect(remoteProfileDeleteFailure(new Error(message))).toBe(reason)
  })
})
