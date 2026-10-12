import { AUTHOR, fixture, issueComment, REPOSITORY, translate } from "./comment-bot.test-helpers"

it("answers GitHub reads from the fake repository and fails loudly on anything else", async () => {
  const f = fixture()
  f.github.comments.set(1, issueComment(1, "hi"))
  const call = (url: string) =>
    (f.context.integrations.authenticatedRequest as jest.Mock)({}, url, { method: "GET" })
  expect((await call(`/repos/${REPOSITORY}/issues/comments/1`)).data).toMatchObject({ id: 1 })
  expect((await call(`/repos/${REPOSITORY}/issues/comments/2`)).status).toBe(404)
  expect(
    (await call(`/repos/${REPOSITORY}/collaborators/${AUTHOR.login}/permission`)).data
  ).toMatchObject({
    permission: "write",
  })
  await expect(call(`/repos/${REPOSITORY}/nope`)).rejects.toThrow("Unexpected fixture URL")
})

it("deduplicates enqueued deliveries by event id and cancels by resource and revision", async () => {
  const f = fixture()
  const enqueue = (eventId: string, revision: string) =>
    f.context.bots.enqueue("run", {
      triggerId: "execute",
      eventId,
      type: "t",
      payload: { revision },
      resource: { kind: "k", id: "r" },
    })
  await enqueue("a", "1")
  await enqueue("a", "1")
  await enqueue("b", "2")
  expect(f.deliveries).toHaveLength(2)
  expect(await f.context.bots.cancelResource("run", { resourceId: "r", exceptRevision: "2" })).toBe(
    1
  )
  expect(f.deliveries.map((row) => row.status)).toEqual(["pending", "dismissed"])
})

it("translates from the plugin's own bundle", () => {
  expect(translate("task.state.waiting")).toBe("waiting for approval")
  expect(translate("reply.expired", { hours: 24 })).toContain("24 hours")
})
