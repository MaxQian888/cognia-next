import { parseCommand } from "./command"
import { findOutputMarker, neutralizeMention, renderBotComment, renderOutputMarker } from "./output"

it("renders and finds a namespaced, versioned marker", () => {
  const marker = renderOutputMarker("cognia-command", "t_1-x")
  expect(marker).toBe("<!-- cognia-command:v1:t_1-x -->")
  expect(findOutputMarker(`answer\n\n${marker}`, "cognia-command")).toBe("t_1-x")
  expect(findOutputMarker("<!--cognia-command:v1:abc-->", "cognia-command")).toBe("abc")
  expect(findOutputMarker(marker, "other")).toBeUndefined()
  expect(findOutputMarker("<!-- cognia-command:v2:abc -->", "cognia-command")).toBeUndefined()
})

it("refuses ids and namespaces that could break out of the comment", () => {
  expect(() => renderOutputMarker("cognia-command", "a --> b")).toThrow("id")
  expect(() => renderOutputMarker("Bad Space", "a")).toThrow("namespace")
  expect(() => findOutputMarker("x", "a.*")).toThrow("namespace")
})

it("neutralizes live mentions so the output never addresses the Bot", () => {
  const out = neutralizeMention("@cognia-bot ask again\nor ping @Cognia-Bot[bot].", "@cognia-bot")
  expect(out).toBe("`@cognia-bot` ask again\nor ping `@Cognia-Bot[bot]`.")
  expect(
    parseCommand(out, { trigger: "@cognia-bot", verbs: ["ask"], bareVerb: "help", maxBytes: 1e6 })
  ).toEqual({
    kind: "none",
  })
})

it("leaves code, other logins and email addresses alone", () => {
  const text = "```\n@cognia-bot ask\n```\n`@cognia-bot` me@cognia-bot.dev @cognia-bot-fan"
  expect(neutralizeMention(text, "@cognia-bot")).toBe(text)
})

it("renders a Bot comment as neutralized text plus the marker on its own line", () => {
  expect(
    renderBotComment("Use @cognia-bot help.\n\n", {
      namespace: "cognia-command",
      id: "t1",
      mention: "@cognia-bot",
    })
  ).toBe("Use `@cognia-bot` help.\n\n<!-- cognia-command:v1:t1 -->")
  expect(renderBotComment("a\r\nb", { namespace: "n", id: "i" })).toBe("a\nb\n\n<!-- n:v1:i -->")
})
