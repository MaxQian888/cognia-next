import { remapExactRoots } from "./root-aliases"

describe("remapExactRoots", () => {
  const aliases = new Map([
    ["/repo", "/bundle/primary"],
    ["/docs", "/bundle/docs"],
  ])

  it("maps each source root to its alias, keeping order", () => {
    expect(remapExactRoots(["/docs", "/repo"], aliases)).toEqual([
      "/bundle/docs",
      "/bundle/primary",
    ])
  })

  it("passes a root with no alias through unchanged", () => {
    expect(remapExactRoots(["/repo", "/elsewhere"], aliases)).toEqual([
      "/bundle/primary",
      "/elsewhere",
    ])
  })

  it("matches on the trimmed path", () => {
    expect(remapExactRoots(["  /repo  "], aliases)).toEqual(["/bundle/primary"])
  })

  it("never extends a mapping to a subdirectory of a source root", () => {
    expect(remapExactRoots(["/repo/packages/app"], aliases)).toEqual(["/repo/packages/app"])
  })

  it("returns an empty list for no values", () => {
    expect(remapExactRoots([], aliases)).toEqual([])
  })
})
