import { render, waitFor } from "@testing-library/react"

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

import { BootProfileStartupProbe } from "./boot-profile-startup-probe"

beforeEach(() => {
  mockProfile = "main"
  mockEnsureBootCapability.mockClear()
  mockProbe.mockClear()
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
