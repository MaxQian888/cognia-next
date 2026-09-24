import { act, render, waitFor } from "@testing-library/react"

let mockProfile = "main"
const mockEnsureBootCapability = jest.fn<Promise<void>, [string]>(() => Promise.resolve())
jest.mock("@/lib/boot/capabilities", () => ({
  getBootProfile: () => mockProfile,
  ensureBootCapability: (capability: string) => mockEnsureBootCapability(capability),
}))
const mockProbe = jest.fn(async () => ["integrations"])
jest.mock("@/lib/boot/startup-probe", () => ({
  probeConfiguredBootCapabilities: () => mockProbe(),
}))
let mockUnlockedAccountId: string | null = "account-a"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: mockUnlockedAccountId }),
}))

import { BootProfileStartupProbe } from "./boot-profile-startup-probe"

beforeEach(() => {
  mockProfile = "main"
  mockUnlockedAccountId = "account-a"
  mockEnsureBootCapability.mockClear()
  mockProbe.mockReset().mockResolvedValue(["integrations"])
})

it("waits for unlock before reading the encrypted database", async () => {
  mockUnlockedAccountId = null
  const { rerender } = render(<BootProfileStartupProbe />)
  expect(mockProbe).not.toHaveBeenCalled()

  mockUnlockedAccountId = "account-a"
  rerender(<BootProfileStartupProbe />)
  await waitFor(() => expect(mockEnsureBootCapability).toHaveBeenCalledWith("integrations"))
})

it("probes again after an account switch and discards the previous account's result", async () => {
  let finishFirst!: (capabilities: string[]) => void
  mockProbe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve
      })
  )
  const { rerender } = render(<BootProfileStartupProbe />)

  mockUnlockedAccountId = "account-b"
  mockProbe.mockResolvedValueOnce(["workflow-automation"])
  rerender(<BootProfileStartupProbe />)
  await waitFor(() => expect(mockEnsureBootCapability).toHaveBeenCalledWith("workflow-automation"))
  await act(async () => finishFirst(["integrations"]))
  expect(mockEnsureBootCapability).not.toHaveBeenCalledWith("integrations")
})

it("does not activate a completed probe after the account locks", async () => {
  let finish!: (capabilities: string[]) => void
  mockProbe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = render(<BootProfileStartupProbe />)
  mockUnlockedAccountId = null
  rerender(<BootProfileStartupProbe />)
  await act(async () => finish(["integrations"]))
  expect(mockEnsureBootCapability).not.toHaveBeenCalled()
})

it("activates configured background capabilities in main mode", async () => {
  render(<BootProfileStartupProbe />)
  await waitFor(() => expect(mockEnsureBootCapability).toHaveBeenCalledWith("integrations"))
})

it("does not probe in eager mode because every capability is already requested", () => {
  mockProfile = "eager"
  render(<BootProfileStartupProbe />)
  expect(mockProbe).not.toHaveBeenCalled()
})
