import {
  activatePluginRuntimeAccount,
  blockPluginRuntimeAccount,
  clearPluginRuntimeAccount,
  pluginRuntimeAccountAvailable,
} from "./account-runtime-gate"

beforeEach(() => clearPluginRuntimeAccount())
afterEach(() => clearPluginRuntimeAccount())

it("fails closed until an account is activated and blocks immediately during teardown", () => {
  expect(pluginRuntimeAccountAvailable()).toBe(false)

  activatePluginRuntimeAccount("acct_a")
  expect(pluginRuntimeAccountAvailable()).toBe(true)

  blockPluginRuntimeAccount("acct_a")
  expect(pluginRuntimeAccountAvailable()).toBe(false)
})

it("does not let a stale account teardown block the current account", () => {
  activatePluginRuntimeAccount("acct_b")
  blockPluginRuntimeAccount("acct_a")
  expect(pluginRuntimeAccountAvailable()).toBe(true)
})
