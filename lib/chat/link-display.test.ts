import {
  brandIdForHost,
  describeLink,
  elideLabel,
  formatLinkRules,
  parseLinkRules,
} from "./link-display"

describe("describeLink — built-in rules", () => {
  it("shortens a GitHub repository to owner/repo", () => {
    const display = describeLink("https://github.com/svenstaro/genact")
    expect(display.label).toBe("svenstaro/genact")
    expect(display.host).toBe("github.com")
    expect(display.brandId).toBe("github")
    expect(display.href).toBe("https://github.com/svenstaro/genact")
  })

  it("keeps the issue / pull number when the URL names one", () => {
    expect(describeLink("https://github.com/a/b/issues/123").label).toBe("a/b#123")
    expect(describeLink("https://github.com/a/b/pull/7").label).toBe("a/b#7")
    expect(describeLink("https://gitlab.com/a/b/merge_requests/9").label).toBe("a/b#9")
  })

  it("falls back to the generic shape for a non-repo path on the same host", () => {
    expect(describeLink("https://github.com/settings").label).toBe("github.com/settings")
  })
})

describe("describeLink — generic fallback", () => {
  it("drops the scheme and www", () => {
    expect(describeLink("https://www.example.com/docs/a").label).toBe("example.com/docs/a")
  })

  it("drops a lone trailing slash", () => {
    expect(describeLink("https://example.com/").label).toBe("example.com")
  })

  it("elides the middle of a long path, keeping host and last segment", () => {
    const display = describeLink(
      "https://example.com/a/very/long/path/that/keeps/going/and/going/final-page"
    )
    expect(display.label).toBe("example.com/…/final-page")
  })

  it("returns the raw string for something that is not a URL", () => {
    expect(describeLink("not a url").label).toBe("not a url")
  })
})

describe("describeLink — user settings", () => {
  it("honours the host-only and full styles", () => {
    const url = "https://github.com/a/b"
    expect(describeLink(url, { style: "host" }).label).toBe("github.com")
    expect(describeLink(url, { style: "full" }).label).toBe(url)
  })

  it("strips a user-declared prefix", () => {
    const display = describeLink("https://wiki.corp.example/display/ENG/Runbook", {
      rules: [{ host: "wiki.corp.example", strip: "https://wiki.corp.example/display/" }],
    })
    expect(display.label).toBe("ENG/Runbook")
  })

  it("lets a user rule override a built-in host", () => {
    const display = describeLink("https://github.com/a/b/tree/main/src", {
      rules: [{ host: "github.com", strip: "https://github.com/" }],
    })
    expect(display.label).toBe("a/b/tree/main/src")
  })

  it("matches a subdomain of the declared host", () => {
    const display = describeLink("https://docs.corp.example/x/y", {
      rules: [{ host: "corp.example", strip: "https://docs.corp.example/" }],
    })
    expect(display.label).toBe("x/y")
  })

  it("keeps the host when a rule would strip the URL down to nothing", () => {
    const display = describeLink("https://x.dev/", {
      rules: [{ host: "x.dev", strip: "https://x.dev/" }],
    })
    expect(display.label).toBe("x.dev")
  })

  it("ignores a rule whose prefix does not actually match the URL", () => {
    const display = describeLink("https://x.dev/a/b", {
      rules: [{ host: "x.dev", strip: "https://other.dev/" }],
    })
    expect(display.label).toBe("x.dev/a/b")
  })

  // A rule that produces no label must not END the search. Both of these
  // used to fall out to the generic host/path form, so one line of settings
  // silently switched GitHub URLs back to `github.com/a/b`.
  it("falls through to the built-in when a user rule produces nothing", () => {
    // `parseLinkRules` builds exactly this shape for a line that is just a host.
    expect(describeLink("https://github.com/a/b", { rules: [{ host: "github.com" }] }).label).toBe(
      "a/b"
    )
    expect(
      describeLink("https://github.com/a/b", {
        rules: [{ host: "github.com", strip: "https://github.com/enterprise/" }],
      }).label
    ).toBe("a/b")
  })
})

describe("brandIdForHost", () => {
  it("takes the label before the public suffix", () => {
    expect(brandIdForHost("github.com")).toBe("github")
    expect(brandIdForHost("docs.google.com")).toBe("google")
    expect(brandIdForHost("huggingface.co")).toBe("huggingface")
  })

  it("looks past a two-part public suffix", () => {
    expect(brandIdForHost("shop.example.co.uk")).toBe("example")
  })

  it("survives a bare host", () => {
    expect(brandIdForHost("localhost")).toBe("localhost")
  })
})

describe("elideLabel", () => {
  it("leaves a short label alone", () => {
    expect(elideLabel("a/b")).toBe("a/b")
  })

  it("tail-truncates when there is no path boundary to cut on", () => {
    expect(elideLabel("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`)
  })
})

describe("parseLinkRules / formatLinkRules", () => {
  it("reads one rule per line, with an optional prefix", () => {
    expect(
      parseLinkRules("github.com = https://github.com/\n\n# a comment\nwiki.corp.example")
    ).toEqual([{ host: "github.com", strip: "https://github.com/" }, { host: "wiki.corp.example" }])
  })

  it("skips a malformed host instead of dropping the whole list", () => {
    expect(parseLinkRules("two words = x\ngood.example = https://good.example/")).toEqual([
      { host: "good.example", strip: "https://good.example/" },
    ])
  })

  it("round-trips through format", () => {
    const text = "github.com = https://github.com/\nwiki.corp.example"
    expect(formatLinkRules(parseLinkRules(text))).toBe(text)
  })
})
