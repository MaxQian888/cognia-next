import { fixture } from "./comment-bot.test-helpers"
import { SetupError } from "./config"
import { readerFor, readIdentity, resolveTrigger } from "./identity"

it("reads the posting identity through the binding and defaults the trigger only for an App", async () => {
  const f = fixture()
  const identity = await readIdentity(readerFor(f.context, f.run, f.config))
  expect(identity).toEqual({ id: 900, login: "cognia-bot[bot]", isApp: true })
  expect(f.mocks.request).toHaveBeenCalledWith(
    { runId: "run", slotId: "github" },
    "/user",
    expect.anything()
  )
  expect(resolveTrigger(f.config, identity)).toBe("@cognia-bot")
  expect(resolveTrigger({ ...f.config, trigger: "@team" }, identity)).toBe("@team")
  const person = { id: 1, login: "maintainer", isApp: false }
  expect(() => resolveTrigger(f.config, person)).toThrow(SetupError)
  expect(resolveTrigger({ ...f.config, trigger: "@team" }, person)).toBe("@team")
})

it("refuses an account that cannot say who it is", async () => {
  const f = fixture()
  f.github.viewer = {} as never
  await expect(readIdentity(readerFor(f.context, f.run, f.config))).rejects.toThrow("identity")
})
