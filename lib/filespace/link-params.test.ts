import {
  FILES_LINK_PARAMS,
  MAX_FILES_LINK_LINE,
  filesViewParams,
  parseFilesViewParams,
  sanitizeFilesLinkLine,
} from "./link-params"
import type { FileSpacePath } from "@/types/filespace"

const q = (query: string) => new URLSearchParams(query)

describe("parseFilesViewParams", () => {
  it("is null unless the link asks for the files view", () => {
    expect(parseFilesViewParams(null)).toBeNull()
    expect(parseFilesViewParams(q("session=s1"))).toBeNull()
    expect(parseFilesViewParams(q("view=chat&path=%2Fworkspace"))).toBeNull()
  })

  it("reads a normalized path and a bounded line", () => {
    expect(parseFilesViewParams(q("view=files&path=workspace%2F%2Fsrc%2Fa.ts&line=12"))).toEqual({
      path: "/workspace/src/a.ts",
      line: 12,
    })
  })

  it("keeps the view when the path is malformed, and drops a bad line", () => {
    expect(parseFilesViewParams(q("view=files&path=%2Fworkspace%2F..%2Fx"))).toEqual({})
    expect(parseFilesViewParams(q("view=files&path=%2F"))).toEqual({})
    expect(parseFilesViewParams(q("view=files"))).toEqual({})
    for (const line of ["0", "-1", "1.5", "abc", String(MAX_FILES_LINK_LINE + 1)]) {
      expect(parseFilesViewParams(q(`view=files&path=%2Fa&line=${line}`))).toEqual({ path: "/a" })
    }
  })
})

describe("filesViewParams", () => {
  it("writes view, then path, then a line only alongside a path", () => {
    expect(filesViewParams({}).toString()).toBe("view=files")
    expect(filesViewParams({ line: 3 }).toString()).toBe("view=files")
    expect(
      filesViewParams({ path: "/workspace/a b.ts" as FileSpacePath, line: 3 }).toString()
    ).toBe("view=files&path=%2Fworkspace%2Fa+b.ts&line=3")
    expect(filesViewParams({ path: "/a" as FileSpacePath, line: 0 }).toString()).toBe(
      "view=files&path=%2Fa"
    )
  })

  it("names every parameter it can write, for consumers that strip a spent link", () => {
    expect([...FILES_LINK_PARAMS]).toEqual(["view", "path", "line"])
  })

  it("accepts only whole lines in range", () => {
    expect(sanitizeFilesLinkLine(undefined)).toBeUndefined()
    expect(sanitizeFilesLinkLine(1)).toBe(1)
    expect(sanitizeFilesLinkLine(MAX_FILES_LINK_LINE)).toBe(MAX_FILES_LINK_LINE)
    expect(sanitizeFilesLinkLine(2.5)).toBeUndefined()
  })
})
