import { render } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => `t:${key}` }))

const dispose = jest.fn()
const bootSites = jest.fn(async () => dispose)
jest.mock("@/lib/sites/boot", () => ({ bootSites: (...args: unknown[]) => bootSites(...args) }))

const unregister = jest.fn()
const installSiteNotificationCommands = jest.fn(() => unregister)
jest.mock("@/lib/sites/notify", () => ({
  installSiteNotificationCommands: (...args: unknown[]) => installSiteNotificationCommands(...args),
}))

let unlockedAccountId: string | null = "owner"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId }),
}))

import { SitesInitializer } from "./sites-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  unlockedAccountId = "owner"
})

it("boots Sites for the unlocked account", async () => {
  render(<SitesInitializer />)
  await Promise.resolve()
  expect(bootSites).toHaveBeenCalledWith(
    expect.objectContaining({ actorAccountId: "owner", translate: expect.any(Function) })
  )
})

it("does nothing while the vault is locked", async () => {
  // Recovery reaches the keyring; there is nothing to reach before unlock.
  unlockedAccountId = null
  render(<SitesInitializer />)
  await Promise.resolve()
  expect(bootSites).not.toHaveBeenCalled()
})

it("boots once per account, not once per render", async () => {
  const { rerender } = render(<SitesInitializer />)
  await Promise.resolve()
  rerender(<SitesInitializer />)
  rerender(<SitesInitializer />)
  await Promise.resolve()
  expect(bootSites).toHaveBeenCalledTimes(1)
})

it("registers the notification command so a Site row can be opened", () => {
  render(<SitesInitializer />)
  expect(installSiteNotificationCommands).toHaveBeenCalledWith(
    expect.objectContaining({ navigate: expect.any(Function) })
  )
  installSiteNotificationCommands.mock.calls[0][0].navigate("/sites?site=site_1")
  expect(push).toHaveBeenCalledWith("/sites?site=site_1")
})

it("tears the watcher down on unmount", async () => {
  const { unmount } = render(<SitesInitializer />)
  await Promise.resolve()
  await Promise.resolve()
  unmount()
  expect(dispose).toHaveBeenCalled()
  expect(unregister).toHaveBeenCalled()
})

it("survives a boot that rejects rather than throwing out of the effect", async () => {
  bootSites.mockRejectedValueOnce(new Error("keyring locked"))
  expect(() => render(<SitesInitializer />)).not.toThrow()
  await Promise.resolve()
})
