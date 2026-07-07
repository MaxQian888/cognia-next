import { discoverOpenPrForBranch } from "./discover"
import type { OctokitLike } from "./types"

function octo(impl: (route: string, params?: Record<string, unknown>) => unknown): OctokitLike {
  return { request: jest.fn(impl) as unknown as OctokitLike["request"] }
}

describe("discoverOpenPrForBranch", () => {
  it("returns the first open PR for the branch and queries head=owner:branch", async () => {
    const o = octo(async () => ({
      status: 200,
      headers: {},
      data: [{ number: 7, html_url: "https://gh/acme/app/pull/7" }],
    }))
    const r = await discoverOpenPrForBranch(o, "acme/app", "agent/run1/dev/task1")
    expect(r).toEqual({ number: 7, url: "https://gh/acme/app/pull/7" })
    expect(o.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls",
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        head: "acme:agent/run1/dev/task1",
        state: "open",
      })
    )
  })

  it("returns null when no PR is open", async () => {
    const o = octo(async () => ({ status: 200, headers: {}, data: [] }))
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toBeNull()
  })

  it("returns null on a thrown 404", async () => {
    const o = octo(async () => {
      throw { status: 404 }
    })
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toBeNull()
  })

  it("returns null on a resolved 404", async () => {
    const o = octo(async () => ({ status: 404, headers: {}, data: undefined }))
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toBeNull()
  })

  it("rethrows non-404 errors", async () => {
    const o = octo(async () => {
      throw { status: 500 }
    })
    await expect(discoverOpenPrForBranch(o, "acme/app", "b")).rejects.toEqual({ status: 500 })
  })

  it("accepts a pre-parsed repo and falls back to api url", async () => {
    const o = octo(async () => ({ status: 200, headers: {}, data: [{ number: 3, url: "api/3" }] }))
    const r = await discoverOpenPrForBranch(o, { fullName: "a/b", owner: "a", name: "b" }, "br")
    expect(r).toEqual({ number: 3, url: "api/3" })
  })

  it("returns null when the payload is not an array", async () => {
    const o = octo(async () => ({ status: 200, headers: {}, data: { message: "unexpected" } }))
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toBeNull()
  })

  it("returns null when the first entry has no numeric number", async () => {
    const o = octo(async () => ({ status: 200, headers: {}, data: [{ html_url: "x" }] }))
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toBeNull()
  })

  it("uses an empty url when neither html_url nor url is present", async () => {
    const o = octo(async () => ({ status: 200, headers: {}, data: [{ number: 4 }] }))
    expect(await discoverOpenPrForBranch(o, "acme/app", "b")).toEqual({ number: 4, url: "" })
  })
})
