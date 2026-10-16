import { memoryStorageArea } from "./storage-area"

describe("memoryStorageArea", () => {
  it("reads null for a missing key and copies values in and out", async () => {
    const area = memoryStorageArea()
    expect(await area.get("missing")).toBeNull()
    const value = { list: [1] }
    await area.set("k", value)
    value.list.push(2)
    const read = await area.get<{ list: number[] }>("k")
    expect(read).toEqual({ list: [1] })
    read!.list.push(3)
    expect(await area.get("k")).toEqual({ list: [1] })
  })

  it("tells listeners of their key only, with null on removal, until they stop", async () => {
    const area = memoryStorageArea()
    const seen: unknown[] = []
    const stop = area.onChange("k", (value) => seen.push(value))
    await area.set("other", 1)
    await area.set("k", 2)
    await area.remove("k")
    stop()
    await area.set("k", 3)
    expect(seen).toEqual([2, null])
    expect(area.snapshot().get("k")).toBe(3)
  })
})
