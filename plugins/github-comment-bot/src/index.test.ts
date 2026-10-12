import plugin, {
  createGithubCommentBot,
  githubCommentBot,
  githubCommentBotDef,
  manifest,
} from "./index"
import { fixture } from "./comment-bot.test-helpers"
import packaged from "../plugin.json"

it("keeps the packaged manifest identical to the module manifest", () => {
  expect(JSON.parse(JSON.stringify(manifest))).toEqual(packaged)
})

it("declares a default-off Bot that can only comment, never approve or merge", () => {
  expect(githubCommentBotDef.triggers.filter((trigger) => "enabledByDefault" in trigger)).toEqual([
    expect.objectContaining({ id: "github", enabledByDefault: false }),
    expect.objectContaining({ id: "poll", enabledByDefault: false }),
  ])
  expect(githubCommentBotDef.requires.integrationActions).toEqual([
    "github.commentIssue",
    "github.commentPr",
    "github.replyToReviewComment",
    "github.updateComment",
    "github.reviewPr",
  ])
  expect(githubCommentBotDef.policy).toMatchObject({
    maxAuthority: "acceptEdits",
    maxConcurrentRuns: 3,
    allowSelfTriggering: false,
  })
  const execute = githubCommentBotDef.triggers.find((trigger) => trigger.id === "execute")
  expect(execute).toMatchObject({
    concurrencyKey: "github-cmd:{{resource.scope}}",
    holdConcurrencyWhileWaiting: false,
  })
  expect(manifest.permissions).not.toContain("network:fetch")
})

it("runs the handler only while active", async () => {
  const f = fixture({ triggerId: "poll", config: { allowedAuthorIds: [] } })
  await expect(githubCommentBot(f.run)).rejects.toThrow("not active")
  await plugin.activate?.(f.context)
  await expect(githubCommentBot(f.run)).resolves.toMatchObject({ summary: "Needs setup" })
  await expect(createGithubCommentBot(f.context)(f.run)).resolves.toMatchObject({
    summary: "Needs setup",
  })
  await plugin.deactivate?.(f.context)
  await expect(githubCommentBot(f.run)).rejects.toThrow("not active")
})
