import { translate } from "./comment-bot.test-helpers"
import {
  cancelledText,
  expiredText,
  helpText,
  notEnabledText,
  statusText,
  trackingText,
  usageText,
} from "./messages"
import manifest from "../plugin.json"

const t = translate as never

it("ships every template in both locales", () => {
  expect(Object.keys(manifest.i18n.locales["zh-CN"]).sort()).toEqual(
    Object.keys(manifest.i18n.locales.en).sort()
  )
})

it("puts the trigger only inside code in help and usage", () => {
  const help = helpText(t, "@cognia-bot")
  expect(help).toContain("@cognia-bot ask")
  expect(help.split("```")[1]).toContain("@cognia-bot")
  expect(usageText(t, "reserved_verb", "@b", "merge")).toContain("`merge`")
  expect(usageText(t, "too_large", "@b")).toContain("16 KiB")
})

it("renders fixed control replies with only safe values", () => {
  expect(notEnabledText(t, "fix")).toContain("`fix`")
  expect(expiredText(t, 24)).toContain("24 hours")
  expect(cancelledText(t, ["0a1b2c3d"])).toBe("Cancelled: `0a1b2c3d`.")
  expect(cancelledText(t, [])).toBe(translate("reply.cancelNothing"))
  expect(statusText(t, [])).toBe(translate("reply.status.none"))
  expect(
    statusText(t, [
      { ref: "0a1b2c3d", state: "completed", url: "https://github.com/x" },
      { ref: "11111111", state: "waiting" },
    ])
  ).toBe(
    "**Tasks in this thread**\n- `0a1b2c3d`: completed (https://github.com/x)\n- `11111111`: waiting for approval"
  )
})

it.each([
  [{ kind: "running" }, "working on it"],
  [{ kind: "waiting" }, "waiting to be published"],
  [{ kind: "completed" }, "answered."],
  [{ kind: "completed", url: "https://github.com/x" }, "https://github.com/x"],
  [{ kind: "failed" }, "failed"],
  [{ kind: "cancelled" }, "cancelled"],
  [{ kind: "blocked", reason: "pii_blocked" }, "personal data"],
  [{ kind: "blocked", reason: "readonly_violation" }, "change files"],
  [{ kind: "blocked", reason: "budget_exceeded" }, "cost limit"],
  [{ kind: "blocked", reason: "recovery_required" }, "interrupted"],
  [{ kind: "blocked", reason: "invalid_result" }, "could not be used"],
  [{ kind: "blocked", reason: "target_changed" }, "changed"],
  [{ kind: "blocked", reason: "context_unavailable" }, "could not be read"],
] as const)("tracks phase %j", (phase, text) => {
  const line = trackingText(t, "0a1b2c3d", phase as never)
  expect(line).toContain("`0a1b2c3d`")
  expect(line).toContain(text)
  expect(line).not.toMatch(/tracking\./)
})
