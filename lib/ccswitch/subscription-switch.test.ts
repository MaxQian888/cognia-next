jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(),
  getActiveAccount: jest.fn(),
  setActiveAccount: jest.fn(),
}))
jest.mock("@/lib/subscription/anthropic/discovery", () => ({
  discoverAnthropicAuth: jest.fn(),
  adoptAndActivateDiscoveredAuth: jest.fn(),
}))

import { listAccounts, getActiveAccount, setActiveAccount } from "@/lib/subscription/core/transport"
import {
  discoverAnthropicAuth,
  adoptAndActivateDiscoveredAuth,
} from "@/lib/subscription/anthropic/discovery"
import { activateSubscriptionForSwitch } from "./subscription-switch"

beforeEach(() => jest.resetAllMocks())

it("reuses the active vault account without adopting another login", async () => {
  jest
    .mocked(listAccounts)
    .mockResolvedValue([{ id: "first" }, { id: "active" }] as Awaited<
      ReturnType<typeof listAccounts>
    >)
  jest
    .mocked(getActiveAccount)
    .mockResolvedValue({ activeAccountId: "active" } as Awaited<
      ReturnType<typeof getActiveAccount>
    >)
  expect(await activateSubscriptionForSwitch()).toEqual({ activated: true, source: "vault" })
  expect(setActiveAccount).toHaveBeenCalledWith("anthropic", "active")
  expect(discoverAnthropicAuth).not.toHaveBeenCalled()
})

it("adopts local Claude login only when the vault is empty", async () => {
  jest.mocked(listAccounts).mockResolvedValue([])
  jest
    .mocked(discoverAnthropicAuth)
    .mockResolvedValue({ accessToken: "fixture" } as NonNullable<
      Awaited<ReturnType<typeof discoverAnthropicAuth>>
    >)
  expect(await activateSubscriptionForSwitch()).toEqual({ activated: true, source: "adopted" })
  expect(adoptAndActivateDiscoveredAuth).toHaveBeenCalledWith({ accessToken: "fixture" })
})

it("reports absence without pretending activation succeeded", async () => {
  jest.mocked(listAccounts).mockResolvedValue([])
  jest.mocked(discoverAnthropicAuth).mockResolvedValue(null)
  expect(await activateSubscriptionForSwitch()).toEqual({ activated: false, error: "none-found" })
  expect(setActiveAccount).not.toHaveBeenCalled()
})

it("reports vault failures without attempting a different credential source", async () => {
  jest.mocked(listAccounts).mockRejectedValue(new Error("vault sealed"))
  expect(await activateSubscriptionForSwitch()).toEqual({ activated: false, error: "vault sealed" })
  expect(discoverAnthropicAuth).not.toHaveBeenCalled()
})
