import { githubResponse, memoizedStep, memoryStorage, routeGithubRequests } from "./testing"

it("keeps storage per instance", async () => {
  const a = memoryStorage()
  const b = memoryStorage()
  await a.set("k", 1)
  expect(await a.get("k")).toBe(1)
  expect(await b.get("k")).toBeUndefined()
  await a.delete("k")
  expect(a.data.size).toBe(0)
})

it("memoizes only completed steps and replays a copy", async () => {
  const step = memoizedStep()
  const fail = jest.fn().mockRejectedValueOnce(new Error("crash")).mockResolvedValue({ n: 1 })
  await expect(step.run("s", fail)).rejects.toThrow("crash")
  const first = await step.run("s", fail)
  const replay = await step.run("s", fail)
  expect(replay).toEqual({ n: 1 })
  expect(replay).not.toBe(first)
  expect(fail).toHaveBeenCalledTimes(2)
})

it("routes repository-relative paths and fails loudly on the unexpected", async () => {
  const request = routeGithubRequests("acme/widgets", (path) => {
    if (path === "") return { default_branch: "main" }
    if (path === "/user") return { id: 1 }
    if (path === "/gone") return githubResponse({ message: "x" }, { status: 404 })
    return undefined
  })
  expect(await request({}, "/repos/acme/widgets")).toEqual({
    status: 200,
    headers: {},
    data: { default_branch: "main" },
  })
  expect((await request({}, "/user")).data).toEqual({ id: 1 })
  expect(await request({}, "/repos/acme/widgets/gone")).toEqual({
    status: 404,
    headers: {},
    data: { message: "x" },
  })
  await expect(request({}, "/repos/acme/widgets/other")).rejects.toThrow("Unexpected fixture URL")
})
