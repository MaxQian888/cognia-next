import { teardownPluginAccountRuntime } from "./account-isolation"

it("blocks first, unloads all runtimes, and clears every permission cache", async () => {
  const calls: string[] = []
  await teardownPluginAccountRuntime("acct_a", {
    block: () => calls.push("block"),
    rejectPendingConsent: () => calls.push("reject"),
    runtimePluginIds: () => ["one", "two"],
    unload: async (pluginId) => {
      calls.push(`unload:${pluginId}`)
    },
    clearConsent: () => calls.push("consent"),
    clearPermissionGuard: () => calls.push("guard"),
    clearApiPermissions: () => calls.push("api"),
    disposeManager: () => calls.push("dispose"),
    clearAccount: () => calls.push("clear-account"),
  })

  expect(calls).toEqual([
    "block",
    "reject",
    "unload:one",
    "unload:two",
    "consent",
    "guard",
    "api",
    "dispose",
    "clear-account",
  ])
})

it("clears authority but rejects the switch when any runtime survives", async () => {
  const cleared: string[] = []
  await expect(
    teardownPluginAccountRuntime("acct_a", {
      block: jest.fn(),
      rejectPendingConsent: jest.fn(),
      runtimePluginIds: () => ["broken"],
      unload: async () => {
        throw new Error("still running")
      },
      clearConsent: () => cleared.push("consent"),
      clearPermissionGuard: () => cleared.push("guard"),
      clearApiPermissions: () => cleared.push("api"),
      disposeManager: () => cleared.push("dispose"),
      clearAccount: () => cleared.push("account"),
    })
  ).rejects.toThrow("still running")
  expect(cleared).toEqual(["consent", "guard", "api", "dispose", "account"])
})
