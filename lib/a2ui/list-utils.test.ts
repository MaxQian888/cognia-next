/**
 * A2UI List Utilities Tests
 */

import { getItemKey, getItemDisplayText } from "./list-utils"

describe("getItemKey", () => {
  it("should return id from object with id property", () => {
    expect(getItemKey({ id: "abc" }, 0)).toBe("abc")
    expect(getItemKey({ id: 42 }, 0)).toBe(42)
  })

  it("should return index for primitive values", () => {
    expect(getItemKey("hello", 3)).toBe(3)
    expect(getItemKey(123, 5)).toBe(5)
    expect(getItemKey(true, 7)).toBe(7)
  })

  it("should return index for null and undefined", () => {
    expect(getItemKey(null, 2)).toBe(2)
    expect(getItemKey(undefined, 4)).toBe(4)
  })

  it("should return index for objects without id", () => {
    expect(getItemKey({ name: "test" }, 1)).toBe(1)
    expect(getItemKey({}, 6)).toBe(6)
  })

  it("should handle id = 0 correctly", () => {
    expect(getItemKey({ id: 0 }, 9)).toBe(0)
  })

  it("should handle id = empty string correctly", () => {
    expect(getItemKey({ id: "" }, 9)).toBe("")
  })
})

describe("getItemDisplayText", () => {
  it("should return string items directly", () => {
    expect(getItemDisplayText("hello")).toBe("hello")
    expect(getItemDisplayText("")).toBe("")
  })

  it("should convert numbers to string", () => {
    expect(getItemDisplayText(42)).toBe("42")
    expect(getItemDisplayText(0)).toBe("0")
    expect(getItemDisplayText(-1.5)).toBe("-1.5")
  })

  it("should convert booleans to string", () => {
    expect(getItemDisplayText(true)).toBe("true")
    expect(getItemDisplayText(false)).toBe("false")
  })

  it("should extract label from object", () => {
    expect(getItemDisplayText({ label: "My Label" })).toBe("My Label")
  })

  it("should extract text from object", () => {
    expect(getItemDisplayText({ text: "Some Text" })).toBe("Some Text")
  })

  it("should extract name from object", () => {
    expect(getItemDisplayText({ name: "Item Name" })).toBe("Item Name")
  })

  it("should extract title from object", () => {
    expect(getItemDisplayText({ title: "A Title" })).toBe("A Title")
  })

  it("should prefer label over other properties", () => {
    expect(getItemDisplayText({ label: "Label", text: "Text", name: "Name", title: "Title" })).toBe(
      "Label"
    )
  })

  it("should fallback to text when label is missing", () => {
    expect(getItemDisplayText({ text: "Text", name: "Name" })).toBe("Text")
  })

  it("should fallback to name when label and text are missing", () => {
    expect(getItemDisplayText({ name: "Name", title: "Title" })).toBe("Name")
  })

  it("should JSON stringify objects without known properties", () => {
    const obj = { foo: "bar" }
    expect(getItemDisplayText(obj)).toBe(JSON.stringify(obj))
  })

  it("should handle null by converting to string", () => {
    expect(getItemDisplayText(null)).toBe("null")
  })

  it("should handle undefined by converting to string", () => {
    expect(getItemDisplayText(undefined)).toBe("undefined")
  })
})
