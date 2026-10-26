import { slackMrkdwnToMarkdown } from "./mrkdwn-to-markdown"

describe("slackMrkdwnToMarkdown", () => {
  it("converts emphasis, links and mentions", () => {
    expect(
      slackMrkdwnToMarkdown(
        "*Deploy* finished for _prod_ ~old~ see <https://x.test/a?b=1&amp;c=2|the log> cc <@U123> <#C9|ops> <!here>"
      )
    ).toBe(
      "**Deploy** finished for *prod* ~~old~~ see [the log](https://x.test/a?b=1&c=2) cc @U123 #ops @here"
    )
  })

  it("leaves code spans and fences unformatted, with entities decoded", () => {
    expect(
      slackMrkdwnToMarkdown(
        "Use `*not bold*` and\n```\n*raw* &lt;tag&gt;\n```\nline two\nline three"
      )
    ).toBe("Use `*not bold*` and\n\n```\n*raw* <tag>\n```\n\nline two  \nline three")
  })

  it("does not treat mid-word markers as emphasis", () => {
    expect(slackMrkdwnToMarkdown("price 2*3*4 and snake_case_name and a*b")).toBe(
      "price 2*3*4 and snake_case_name and a*b"
    )
  })

  it("keeps escaped HTML characters escaped in prose and restores quote markers", () => {
    expect(slackMrkdwnToMarkdown("&lt;script&gt; &amp; <mailto:a@b.test|mail>")).toBe(
      "&lt;script&gt; &amp; [mail](mailto:a@b.test)"
    )
    expect(slackMrkdwnToMarkdown("&gt; quoted *line*")).toBe("> quoted **line**")
  })

  it("uses the readable label of special commands", () => {
    expect(
      slackMrkdwnToMarkdown("<!subteam^S1|@devs> <!date^1392734382^{date}|Feb 18> <!channel>")
    ).toBe("@devs Feb 18 @channel")
  })

  it("links a bare URL to itself and escapes brackets in labels", () => {
    expect(slackMrkdwnToMarkdown("<https://x.test/a b>")).toBe(
      "[https://x.test/a b](https://x.test/a%20b)"
    )
    expect(slackMrkdwnToMarkdown("<https://x.test|[draft]>")).toBe("[\\[draft\\]](https://x.test)")
  })
})
