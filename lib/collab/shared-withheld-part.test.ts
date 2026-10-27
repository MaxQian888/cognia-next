import {
  SHARED_WITHHELD_PART_TYPE,
  isSharedWithheldPart,
  sharedWithheldPart,
} from "./shared-withheld-part"

it("builds a content-free placeholder that names only its reason", () => {
  expect(sharedWithheldPart("pii")).toEqual({
    type: SHARED_WITHHELD_PART_TYPE,
    data: { reason: "pii" },
  })
})

it("recognises only a well-formed placeholder", () => {
  expect(isSharedWithheldPart(sharedWithheldPart("pii"))).toBe(true)
  expect(isSharedWithheldPart({ type: SHARED_WITHHELD_PART_TYPE })).toBe(false)
  expect(isSharedWithheldPart({ type: SHARED_WITHHELD_PART_TYPE, data: { reason: "x" } })).toBe(
    false
  )
  expect(isSharedWithheldPart({ type: "text", text: "hi" })).toBe(false)
  expect(isSharedWithheldPart(null)).toBe(false)
})
