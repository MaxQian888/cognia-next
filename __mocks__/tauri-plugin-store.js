// Mock for @tauri-apps/plugin-store — its native side fails to load in jsdom.
// Provide just enough of the surface for test code paths to behave.

class LazyStore {
  constructor() {}
  async get() {
    return null
  }
  async set() {}
  async save() {}
  async delete() {}
  async clear() {}
  async keys() {
    return []
  }
  async values() {
    return []
  }
  async entries() {
    return []
  }
  async length() {
    return 0
  }
  async load() {}
  async reset() {}
  onChange() {
    return () => {}
  }
  onKeyChange() {
    return () => {}
  }
}

class Store extends LazyStore {}

module.exports = { LazyStore, Store }
