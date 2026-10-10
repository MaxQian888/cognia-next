import { ariaSortFor, nextFilesSort } from "./column-sort"

describe("files column sort", () => {
  it("starts names A→Z, then Z→A, then the view's order", () => {
    const first = nextFilesSort(null, "name")
    expect(first).toEqual({ key: "name", dir: "asc" })
    const second = nextFilesSort(first, "name")
    expect(second).toEqual({ key: "name", dir: "desc" })
    expect(nextFilesSort(second, "name")).toBeNull()
  })

  it("starts dates and sizes newest/largest first", () => {
    expect(nextFilesSort(null, "activity")).toEqual({ key: "activity", dir: "desc" })
    expect(nextFilesSort({ key: "size", dir: "desc" }, "size")).toEqual({ key: "size", dir: "asc" })
    expect(nextFilesSort({ key: "size", dir: "asc" }, "size")).toBeNull()
  })

  it("switching column starts the new one fresh", () => {
    expect(nextFilesSort({ key: "name", dir: "desc" }, "type")).toEqual({ key: "type", dir: "asc" })
  })

  it("reports aria-sort per column", () => {
    expect(ariaSortFor(null, "name")).toBe("none")
    expect(ariaSortFor({ key: "name", dir: "asc" }, "name")).toBe("ascending")
    expect(ariaSortFor({ key: "name", dir: "desc" }, "name")).toBe("descending")
    expect(ariaSortFor({ key: "name", dir: "desc" }, "size")).toBe("none")
  })
})
