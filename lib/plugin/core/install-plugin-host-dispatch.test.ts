import {
  getPluginHostDispatch,
  installPluginHostDispatch,
  isPluginHostDispatchInstalled,
} from "@cognia/plugin-contract/lib/plugin/core/plugin-host-dispatch"
import { hostPluginDispatch, installHostPluginDispatch } from "./install-plugin-host-dispatch"

const dispatchSlashCommand = jest.fn()
const bindPluginShortcut = jest.fn()
const execute = jest.fn()

jest.mock("@/lib/slash-commands/registry", () => ({
  dispatchSlashCommand: (...args: unknown[]) => dispatchSlashCommand(...args),
}))
jest.mock("@/lib/plugin/shortcuts/plugin-shortcut-bridge", () => ({
  bindPluginShortcut: (...args: unknown[]) => bindPluginShortcut(...args),
}))
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: { acme: { commands: [{ id: "acme.open", execute }] } },
    }),
  },
}))

afterEach(() => installPluginHostDispatch(null))

it("installs the host dispatcher into the contract seam", () => {
  installHostPluginDispatch()
  expect(isPluginHostDispatchInstalled()).toBe(true)
  expect(getPluginHostDispatch()).toBe(hostPluginDispatch)
})

it("forwards slash lines to the host slash registry", async () => {
  dispatchSlashCommand.mockResolvedValueOnce({ message: "done" })
  await expect(
    hostPluginDispatch.dispatchSlashCommand("/x a", { signal: undefined })
  ).resolves.toEqual({
    message: "done",
  })
  expect(dispatchSlashCommand).toHaveBeenCalledWith("/x a", { signal: undefined })
})

it("finds a plugin's own manifest command in the plugin store", async () => {
  await expect(hostPluginDispatch.findManifestCommand("acme", "acme.open")).resolves.toMatchObject({
    id: "acme.open",
  })
  await expect(hostPluginDispatch.findManifestCommand("acme", "other")).resolves.toBeUndefined()
  await expect(
    hostPluginDispatch.findManifestCommand("ghost", "acme.open")
  ).resolves.toBeUndefined()
})

it("binds accelerators through the plugin shortcut bridge", async () => {
  const dispose = jest.fn()
  bindPluginShortcut.mockResolvedValueOnce(dispose)
  const request = { pluginId: "acme", chord: "Ctrl+K", existingCommandId: "qa:acme:x" }
  await expect(hostPluginDispatch.bindPluginShortcut(request)).resolves.toBe(dispose)
  expect(bindPluginShortcut).toHaveBeenCalledWith(request)
})
