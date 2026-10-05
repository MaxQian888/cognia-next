import { fromUtf8 } from "./bytes"
import { LABEL_PREFIX, labelled } from "./labels"

it("prefixes every label and separates it from the data with one zero byte", () => {
  const bytes = labelled("entry", new Uint8Array([1, 2]))
  const label = `${LABEL_PREFIX}entry`
  expect(fromUtf8(bytes.subarray(0, label.length))).toBe("cognia-sync/v1/entry")
  expect([...bytes.subarray(label.length)]).toEqual([0, 1, 2])
  expect([...labelled("sas")].at(-1)).toBe(0)
})
