import { ignoreMissingSecureStorageItem, isMissingSecureStorageItem } from "./secure-storage"

describe("native secure storage absence classification", () => {
  it.each([
    "Item with given key does not exist",
    new Error("Item with given key does not exist"),
    { message: "Item with given key does not exist" },
  ])("accepts the exact native missing-item error %p", (error) => {
    expect(isMissingSecureStorageItem(error)).toBe(true)
    expect(() => ignoreMissingSecureStorageItem(error)).not.toThrow()
  })

  it.each([
    new Error("Secure storage read failed"),
    { message: "Secure storage is unavailable" },
    new Error("Remove failed"),
    new Error("Keystore key does not exist"),
    null,
  ])("preserves every other failure %p", (error) => {
    expect(isMissingSecureStorageItem(error)).toBe(false)
    let caught: unknown = Symbol("not thrown")
    try {
      ignoreMissingSecureStorageItem(error)
    } catch (failure) {
      caught = failure
    }
    expect(caught).toBe(error)
  })
})
