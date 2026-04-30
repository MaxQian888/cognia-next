jest.mock("./storage-manager", () => ({
  StorageManager: { default: true },
  StorageManagerImpl: class {},
}))
jest.mock("./cleanup", () => ({
  cleanupCategories: jest.fn(),
  clearCategory: jest.fn(),
  deepCleanup: jest.fn(),
  previewCleanup: jest.fn(),
  quickCleanup: jest.fn(),
  selectableCategories: jest.fn(),
}))

import * as storage from "./index"

describe("storage barrel", () => {
  it("re-exports CATEGORY_INFO and helpers", () => {
    expect(storage.CATEGORY_INFO).toBeDefined()
    expect(typeof storage.categoryForTable).toBe("function")
    expect(typeof storage.defaultDisplayName).toBe("function")
    expect(storage.TABLE_TO_CATEGORY).toBeDefined()
  })

  it("re-exports the storage-manager bindings", () => {
    expect(storage.StorageManager).toBeDefined()
    expect(storage.StorageManagerImpl).toBeDefined()
  })

  it("re-exports cleanup helpers", () => {
    expect(typeof storage.cleanupCategories).toBe("function")
    expect(typeof storage.clearCategory).toBe("function")
    expect(typeof storage.deepCleanup).toBe("function")
    expect(typeof storage.previewCleanup).toBe("function")
    expect(typeof storage.quickCleanup).toBe("function")
    expect(typeof storage.selectableCategories).toBe("function")
  })
})
