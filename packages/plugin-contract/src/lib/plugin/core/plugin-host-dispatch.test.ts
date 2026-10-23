import {
  getPluginHostDispatch,
  installPluginHostDispatch,
  isPluginHostDispatchInstalled,
  PluginHostDispatchUnavailableError,
  type PluginHostDispatch,
} from "./plugin-host-dispatch"

afterEach(() => installPluginHostDispatch(null))

it("is inert until a host installs a dispatcher", async () => {
  expect(isPluginHostDispatchInstalled()).toBe(false)
  const dispatch = getPluginHostDispatch()
  await expect(dispatch.dispatchSlashCommand("/x")).rejects.toBeInstanceOf(
    PluginHostDispatchUnavailableError
  )
  await expect(dispatch.findManifestCommand("p", "c")).resolves.toBeUndefined()
  await expect(dispatch.bindPluginShortcut({ pluginId: "p", chord: "Ctrl+K" })).rejects.toThrow(
    "plugin host dispatch is not installed: cannot bind a shortcut outside the Cognia host"
  )
})

it("routes through the installed dispatcher, and null restores the inert default", async () => {
  const installed: PluginHostDispatch = {
    dispatchSlashCommand: jest.fn(async () => ({ message: "ran" })),
    findManifestCommand: jest.fn(async () => ({ id: "c", execute: () => {} })),
    bindPluginShortcut: jest.fn(async () => () => {}),
  }
  installPluginHostDispatch(installed)
  expect(isPluginHostDispatchInstalled()).toBe(true)
  await expect(getPluginHostDispatch().dispatchSlashCommand("/x", {})).resolves.toEqual({
    message: "ran",
  })
  expect(installed.dispatchSlashCommand).toHaveBeenCalledWith("/x", {})
  installPluginHostDispatch(null)
  expect(isPluginHostDispatchInstalled()).toBe(false)
})
