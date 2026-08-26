import {
  expandFoldedLinks,
  foldLinks,
  foldedLinkSpans,
  foldedToken,
  isFoldableLabel,
  LINK_MARKER,
  pruneFoldedLinks,
  stripLinkMarker,
} from "./link-fold"
import { describeLink } from "./link-display"

const label = (url: string) => describeLink(url).label
const fold = (text: string, caret = -1, links = {}) => foldLinks(text, { caret, links, label })
/** What a folded label looks like in the text: one icon cell, then the label. */
const tok = (label: string) => `${LINK_MARKER}${label}`

describe("foldLinks", () => {
  it("folds a settled URL to its short label and remembers the original", () => {
    const result = fold("look at https://github.com/svenstaro/genact please")
    expect(result.text).toBe(`look at ${tok("svenstaro/genact")} please`)
    expect(result.links).toEqual({
      [tok("svenstaro/genact")]: "https://github.com/svenstaro/genact",
    })
    expect(result.changed).toBe(true)
  })

  it("leaves the URL alone while the caret is still inside it", () => {
    const text = "https://github.com/svenst"
    const result = fold(text, text.length)
    expect(result.text).toBe(text)
    expect(result.changed).toBe(false)
  })

  it("folds once the caret has moved past the URL", () => {
    const text = "https://github.com/a/b more"
    const result = fold(text, text.length)
    expect(result.text).toBe(`${tok("a/b")} more`)
  })

  it("moves the caret back by exactly what it removed", () => {
    const text = "https://github.com/a/b tail"
    // Caret at the end: 22 chars of URL became 5 (two icon cells + "a/b").
    expect(fold(text, text.length).caret).toBe(text.length - 17)
  })

  it("leaves a caret that sits before the fold untouched", () => {
    const text = "x https://github.com/a/b"
    expect(fold(text, 1).caret).toBe(1)
  })

  it("folds several URLs in one pass", () => {
    const result = fold("https://github.com/a/b and https://github.com/c/d")
    expect(result.text).toBe(`${tok("a/b")} and ${tok("c/d")}`)
    expect(Object.keys(result.links).sort()).toEqual([tok("a/b"), tok("c/d")])
  })

  it("refuses to reuse a label another URL already owns", () => {
    const first = fold("https://github.com/a/b")
    const second = foldLinks(`${first.text} https://gitlab.com/a/b`, {
      caret: -1,
      links: first.links,
      label,
    })
    // The second URL keeps its full form rather than pointing `a/b` at two
    // different pages.
    expect(second.text).toBe(`${tok("a/b")} https://gitlab.com/a/b`)
  })

  it("folds a bare host down to the host itself — one rule, no size threshold", () => {
    // Consistency beats cleverness here: every link reads the same way, so blue
    // text always means "folded link" and never "a short URL we left alone".
    const result = fold("https://x.dev")
    expect(result.text).toBe(tok("x.dev"))
    expect(result.links).toEqual({ [tok("x.dev")]: "https://x.dev" })
  })

  it("forgets a link whose token the user deleted", () => {
    const links = {
      [tok("a/b")]: "https://github.com/a/b",
      [tok("c/d")]: "https://github.com/c/d",
    }
    expect(pruneFoldedLinks(`only ${tok("a/b")} left`, links)).toEqual({
      [tok("a/b")]: "https://github.com/a/b",
    })
  })
})

// `findUrlSpans` trims the unbalanced closer off `(https://…)`, so the folded
// token ends up bracketed on BOTH sides. Matching only the trailing end dropped
// the map entry in the very call that created it, and the URL went out as prose.
describe("links wrapped in punctuation", () => {
  const url = "https://github.com/svenstaro/genact"

  it("keeps the map entry for a parenthesised link", () => {
    const result = fold(`see (${url}) now`)
    expect(result.text).toBe(`see (${tok("svenstaro/genact")}) now`)
    expect(result.links).toEqual({ [tok("svenstaro/genact")]: url })
    expect(expandFoldedLinks(result.text, result.links)).toBe(`see (${url}) now`)
  })

  it("keeps it through a quote, a bracket, and a later prune", () => {
    for (const [open, close] of [
      ['"', '"'],
      ["[", "]"],
      ["{", "}"],
    ]) {
      const result = fold(`${open}${url}${close}`)
      expect(result.links).toEqual({ [tok("svenstaro/genact")]: url })
      expect(pruneFoldedLinks(result.text, result.links)).toEqual(result.links)
      expect(expandFoldedLinks(result.text, result.links)).toBe(`${open}${url}${close}`)
    }
  })

  it("paints the label without the brackets around it", () => {
    const links = { [tok("svenstaro/genact")]: url }
    const text = `(${tok("svenstaro/genact")})`
    expect(foldedLinkSpans(text, links)).toEqual([
      { raw: tok("svenstaro/genact"), url, start: 1, end: 1 + tok("svenstaro/genact").length },
    ])
  })
})

describe("expandFoldedLinks", () => {
  const token = tok("svenstaro/genact")
  const links = { [token]: "https://github.com/svenstaro/genact" }

  it("puts the full URL back", () => {
    expect(expandFoldedLinks(`look at ${token} please`, links)).toBe(
      "look at https://github.com/svenstaro/genact please"
    )
  })

  it("keeps punctuation the user typed after the token", () => {
    expect(expandFoldedLinks(`see ${token}.`, links)).toBe(
      "see https://github.com/svenstaro/genact."
    )
  })

  it("leaves an edited token as the literal text it now is", () => {
    expect(expandFoldedLinks(token.slice(0, -1), links)).toBe(token.slice(0, -1))
  })

  it("only matches whole tokens", () => {
    expect(expandFoldedLinks(`x${token}`, links)).toBe(`x${token}`)
  })

  it("is a no-op without folded links", () => {
    expect(expandFoldedLinks("plain text", {})).toBe("plain text")
  })

  it("round-trips what fold produced", () => {
    const text = "a https://github.com/x/y b https://github.com/p/q"
    const folded = fold(text)
    expect(expandFoldedLinks(folded.text, folded.links)).toBe(text)
  })
})

describe("foldedLinkSpans", () => {
  const token = tok("a/b")
  const links = { [token]: "https://github.com/a/b" }

  it("reports where each label sits, icon cell included", () => {
    const text = `see ${token} now`
    const [span] = foldedLinkSpans(text, links)
    expect(text.slice(span.start, span.end)).toBe(token)
    expect(span.url).toBe("https://github.com/a/b")
  })

  it("excludes trailing punctuation from the span", () => {
    const text = `see ${token}.`
    const [span] = foldedLinkSpans(text, links)
    expect(text.slice(span.start, span.end)).toBe(token)
  })

  it("reports nothing for an edited token", () => {
    expect(foldedLinkSpans(`${token}x`, links)).toEqual([])
  })
})

describe("the marker cell", () => {
  it("prefixes exactly one character, which strips back off", () => {
    expect(foldedToken("a/b")).toBe(`${LINK_MARKER}a/b`)
    // Two cells: one is too narrow for a legible mark, and leaves no gap.
    expect(LINK_MARKER).toHaveLength(2)
    expect(stripLinkMarker(foldedToken("a/b"))).toBe("a/b")
    expect(stripLinkMarker("a/b")).toBe("a/b")
  })

  it("is not an emoji — an emoji glyph would show through the icon", () => {
    expect(/\p{Emoji_Presentation}|\uFE0F/u.test(LINK_MARKER)).toBe(false)
  })
})

describe("isFoldableLabel", () => {
  it("rejects a marker-only token, whitespace, and a token that saves nothing", () => {
    expect(isFoldableLabel(LINK_MARKER, "https://x.dev/a")).toBe(false)
    expect(isFoldableLabel(tok("a b"), "https://x.dev/a")).toBe(false)
    expect(isFoldableLabel(tok("https://x.dev/a"), "https://x.dev/a")).toBe(false)
  })
})
