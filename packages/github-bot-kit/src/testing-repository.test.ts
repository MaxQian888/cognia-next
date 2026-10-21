import {
  AUTHOR,
  BOT,
  REPOSITORY,
  REPOSITORY_ID,
  fakeGithub,
  githubResponse,
  issueComment,
  routeFake,
} from "./testing"

describe("fake GitHub repository", () => {
  it("answers repository reads from its mutable state", async () => {
    const github = fakeGithub()
    const read = routeFake(github)
    expect((await read({}, `/repos/${REPOSITORY}`)).data).toEqual({
      id: Number(REPOSITORY_ID),
      default_branch: "main",
    })
    expect((await read({}, "/user")).data).toEqual(BOT)
    expect((await read({}, `/repos/${REPOSITORY}/pulls/8`)).data).toMatchObject({ number: 8 })

    github.comments.set(5, issueComment(5, "hello"))
    expect((await read({}, `/repos/${REPOSITORY}/issues/7/comments`)).data).toEqual([
      expect.objectContaining({ id: 5, body: "hello", user: AUTHOR }),
    ])
  })

  it("returns 404s for missing items and honours overrides first", async () => {
    const github = fakeGithub()
    const read = routeFake(github)
    expect((await read({}, `/repos/${REPOSITORY}/issues/comments/99`)).status).toBe(404)
    github.overrides.set("/pulls/8", githubResponse({ message: "gone" }, { status: 410 }))
    expect((await read({}, `/repos/${REPOSITORY}/pulls/8`)).status).toBe(410)
  })

  it("fails loudly on a URL the fake does not model", async () => {
    await expect(routeFake(fakeGithub())({}, `/repos/${REPOSITORY}/releases`)).rejects.toThrow(
      /Unexpected fixture URL/
    )
  })

  it("hands each suite independent state", () => {
    const first = fakeGithub()
    first.items.clear()
    expect(fakeGithub().items.size).toBe(2)
  })
})
