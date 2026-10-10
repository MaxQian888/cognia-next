import { readFileSync } from "node:fs"
import { join } from "node:path"

import { OPEN_FAILURE_MESSAGE_KEY } from "./messages"

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages
    )
}

describe("OPEN_FAILURE_MESSAGE_KEY", () => {
  it("names every failure an open can report", () => {
    expect(Object.keys(OPEN_FAILURE_MESSAGE_KEY).sort()).toEqual(
      ["no-backend", "not-found", "offline", "outside", "session-changed"].sort()
    )
  })

  it.each(["en", "zh-CN"])("resolves every key in the %s filespace messages", (locale) => {
    const messages = JSON.parse(
      readFileSync(join(__dirname, `../../i18n/messages/${locale}/filespace.json`), "utf8")
    ) as Record<string, unknown>
    for (const key of Object.values(OPEN_FAILURE_MESSAGE_KEY)) {
      expect(typeof lookup(messages, key)).toBe("string")
    }
  })
})
