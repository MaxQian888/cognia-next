/**
 * Jest mock for `@tauri-apps/api/core`.
 *
 * jsdom can't host the Tauri IPC bridge, so this stub returns the minimum
 * shape consumers of `@tauri-apps/api/core` (including `@tauri-apps/plugin-fs`
 * and `@tauri-apps/plugin-*` packages that `extend core.Resource`) need to
 * load successfully. Tests that exercise real IPC call surfaces mock
 * `invoke` directly via `jest.mock`.
 */
class Resource {
  constructor(rid) {
    this.rid = rid
  }
  async close() {
    return undefined
  }
}

class Channel {
  constructor() {
    this.onmessage = undefined
  }
  toJSON() {
    return "__CHANNEL__"
  }
}

class PluginListener {
  constructor(plugin, event, channelId) {
    this.plugin = plugin
    this.event = event
    this.channelId = channelId
  }
  async unregister() {
    return undefined
  }
}

module.exports = {
  invoke: jest.fn(),
  Resource,
  Channel,
  PluginListener,
  SERIALIZE_TO_IPC_FN: Symbol.for("SERIALIZE_TO_IPC_FN"),
  addPluginListener: jest.fn().mockResolvedValue(new PluginListener("", "", 0)),
  checkPermissions: jest.fn().mockResolvedValue({}),
  convertFileSrc: jest.fn((p) => p),
  isTauri: () => false,
  requestPermissions: jest.fn().mockResolvedValue({}),
  transformCallback: jest.fn(() => 0),
}
