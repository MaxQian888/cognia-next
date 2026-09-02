import { render } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRef } from "react"
import { ComposerChipOverlay, OVERLAY_FONT_SIZE } from "./composer-chip-overlay"
import { parseSegments, splitLinkSegments } from "@/lib/slash-commands/parse-segments"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { LINK_MARKER } from "@/lib/chat/link-fold"
import { splitParamSegments } from "@/lib/chat/template/param-segments"

const known = (n: string) => ["help", "model", "review"].includes(n)
const segs = (v: string) => parseSegments(v, known, { mentions: true })
/** The overlay's real input in the composer: mentions AND parameters split out. */
const richSegs = (v: string) => splitParamSegments(segs(v), computeCodeRanges(v))

describe("ComposerChipOverlay", () => {
  it("is aria-hidden and does not capture pointer events", () => {
    const { getByTestId } = render(<ComposerChipOverlay value="hi" segments={segs("hi")} />)
    const overlay = getByTestId("composer-chip-overlay")
    expect(overlay).toHaveAttribute("aria-hidden", "true")
    expect(overlay.className).toContain("pointer-events-none")
  })

  it("pills only the /command token, leaving args as plain text", () => {
    const value = "/model opus\n/review auth"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const pills = container.querySelectorAll('[data-chip="command"]')
    expect(pills).toHaveLength(2)
    // The chip wraps only "/model" / "/review" — args stay outside the pill.
    expect(pills[0].textContent).toBe("/model")
    expect(pills[1].textContent).toBe("/review")
    // No character is dropped — args still rendered (transparently) for height.
    expect(container.textContent).toBe("/model opus\n/review auth")
  })

  it("does not pill the args even when they contain slashes (/reset //// case)", () => {
    const value = "/review ////////"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const pills = container.querySelectorAll('[data-chip="command"]')
    expect(pills).toHaveLength(1)
    expect(pills[0].textContent).toBe("/review") // slashes are NOT in the chip
    expect(container.textContent).toBe("/review ////////")
  })

  it("renders no pills for plain prose", () => {
    const value = "just a normal message"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(0)
    // Still paints the text so the box height matches the textarea.
    expect(container.textContent).toContain("just a normal message")
  })

  it("sizes the inner layer from the textarea's own size variable, not a pinned number", () => {
    // The overlay paints the glyphs the transparent textarea still owns the
    // caret for, so the two must be the SAME size. globals.css's iOS zoom guard
    // makes that size 16px on a coarse pointer and `text-sm` elsewhere, so a
    // hard-coded `max(16px, 1rem)` here was right on a phone and one glyph out
    // per three characters on the desktop. `--composer-text-size` is declared
    // in both regimes beside the guard; nothing else may be substituted here.
    const { getByTestId } = render(<ComposerChipOverlay value="/help" segments={segs("/help")} />)
    const layer = getByTestId("composer-chip-overlay").firstElementChild as HTMLElement
    expect(layer.style.fontSize).toBe(OVERLAY_FONT_SIZE)
    expect(OVERLAY_FONT_SIZE).toBe("var(--composer-text-size, 0.875rem)")
    expect(layer.className).toContain("min-h-9")
  })

  it("resolves against a variable globals.css declares in BOTH pointer regimes", () => {
    // Half of the contract lives in CSS: the variable has to exist outside the
    // media query (the desktop answer) AND inside it (the zoom guard's 16px).
    // Declared in only one, the overlay would fall back to `text-sm` on a phone
    // where the textarea is 16px — the same drift, other way round.
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")
    const guard = css.indexOf("@media (pointer: coarse), (hover: none) {")
    expect(guard).toBeGreaterThan(-1)
    expect(css.slice(0, guard)).toContain("--composer-text-size: var(--text-sm, 0.875rem)")
    expect(css.slice(guard)).toContain("--composer-text-size: max(16px, 1rem)")
  })

  it("hands every mirror layer the same size, so none of them can drift alone", () => {
    // The chip layer is not the only one aligned to the textarea: ghost text and
    // the `!`-mode squiggles paint over the same glyphs. They import this
    // constant rather than restating it, and this pins that they still do.
    const sources = [
      "components/chat/composer/composer-ghost-text.tsx",
      "components/chat/composer/shell-diagnostic-overlay.tsx",
      "components/chat/composer/composer-box.tsx",
    ].map((rel) => readFileSync(join(process.cwd(), rel), "utf8"))
    expect(sources).toHaveLength(3)
    for (const src of sources) {
      expect(src).toContain("OVERLAY_FONT_SIZE")
      expect(src).not.toMatch(/fontSize:\s*"max\(16px/)
    }
  })

  it("forwards a ref to the scroll-transform inner element", () => {
    const ref = createRef<HTMLDivElement>()
    render(<ComposerChipOverlay ref={ref} value="/help" segments={segs("/help")} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it("keeps prose between commands as transparent text (full coverage)", () => {
    const value = "/help\nplease explain"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.textContent).toContain("please explain")
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(1)
  })

  it("paints the text itself, above the textarea, without dropping a character", () => {
    const value = "/model opus\nping @alice"
    const { container, getByTestId } = render(
      <ComposerChipOverlay value={value} segments={segs(value)} />
    )
    // This layer IS the visible text now (the textarea's own glyphs are
    // transparent), so it must sit ABOVE the textarea — a text layer under the
    // selection highlight disappears the moment anything is selected.
    const overlay = getByTestId("composer-chip-overlay")
    expect(overlay.className).toContain("z-[2]")
    expect(overlay.firstElementChild!.className).not.toContain("text-transparent")
    // The command pill carries the command token; full text is preserved overall.
    expect(container.querySelector('[data-chip="command"]')?.textContent).toBe("/model")
    expect(container.textContent).toBe("/model opus\nping @alice")
  })

  it("steps aside while an IME composition is in flight", () => {
    // It only ever sees the COMMITTED value, so mid-composition the textarea
    // paints its own glyphs and this layer must not double-print them.
    const { getByTestId } = render(
      <ComposerChipOverlay value="/help" segments={segs("/help")} hidden />
    )
    const overlay = getByTestId("composer-chip-overlay")
    expect(overlay.className).toContain("invisible")
    expect(overlay).toHaveAttribute("data-hidden", "true")
  })

  it("renders a pill for each @mention and keeps full coverage", () => {
    const value = "ping @alice on @lib/db"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const mentions = container.querySelectorAll('[data-chip="mention"]')
    expect(Array.from(mentions).map((m) => m.textContent)).toEqual(["@alice", "@lib/db"])
    expect(container.textContent).toBe("ping @alice on @lib/db")
  })

  it("does not paint a pill for an email address", () => {
    const value = "mail me at user@host.com"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.querySelectorAll('[data-chip="mention"]')).toHaveLength(0)
    expect(container.textContent).toContain("user@host.com")
  })

  describe("{{parameter}} pills", () => {
    it("pills a parameter token and keeps every character", () => {
      const value = "fix {{module}} please"
      const { container } = render(<ComposerChipOverlay value={value} segments={richSegs(value)} />)

      const pills = container.querySelectorAll('[data-chip="param"]')
      expect(pills).toHaveLength(1)
      // The pill paints the token itself, never a value: this layer is a
      // character-for-character mirror of the textarea, so any substitution
      // here shifts every pill after it out of alignment.
      expect(pills[0].textContent).toBe("{{module}}")
      expect(container.textContent).toBe(value)
    })

    it("reads as empty until something binds a value", () => {
      const value = "{{module}}"
      const { container } = render(<ComposerChipOverlay value={value} segments={richSegs(value)} />)

      expect(container.querySelector('[data-chip="param"]')).toHaveAttribute(
        "data-param-state",
        "empty"
      )
    })

    it("takes its state from the caller, one pill at a time", () => {
      const value = "{{a}} {{b}} {{c}}"
      const state = { a: "filled", b: "unresolved", c: "empty" } as const
      const { container } = render(
        <ComposerChipOverlay
          value={value}
          segments={richSegs(value)}
          paramState={(id) => state[id as keyof typeof state]}
        />
      )

      expect(
        [...container.querySelectorAll('[data-chip="param"]')].map((el) =>
          el.getAttribute("data-param-state")
        )
      ).toEqual(["filled", "unresolved", "empty"])
    })

    it("paints nothing inside a fenced block", () => {
      const value = "live {{x}}\n```\n{{ jinja }}\n```"
      const { container } = render(<ComposerChipOverlay value={value} segments={richSegs(value)} />)

      const pills = container.querySelectorAll('[data-chip="param"]')
      expect(pills).toHaveLength(1)
      expect(pills[0].textContent).toBe("{{x}}")
      expect(container.textContent).toBe(value)
    })

    it("paints parameters and mentions side by side", () => {
      const value = "@src/a.ts needs {{module}}"
      const { container } = render(<ComposerChipOverlay value={value} segments={richSegs(value)} />)

      expect(container.querySelectorAll('[data-chip="mention"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-chip="param"]')).toHaveLength(1)
      expect(container.textContent).toBe(value)
    })
  })
})

describe("ComposerChipOverlay — alignment with the textarea", () => {
  it("takes the code font when the skin puts the textarea in it", () => {
    // The overlay is a separate element from the <textarea>, so a mono skin
    // that only styled the textarea left proportional pills under monospace
    // glyphs — every chip after the first drifted off its token.
    const { getByTestId, rerender } = render(
      <ComposerChipOverlay value="/help" segments={segs("/help")} mono />
    )
    expect(getByTestId("composer-chip-overlay").firstElementChild).toHaveClass("font-mono")
    rerender(<ComposerChipOverlay value="/help" segments={segs("/help")} />)
    expect(getByTestId("composer-chip-overlay").firstElementChild).not.toHaveClass("font-mono")
  })
})

describe("ComposerChipOverlay — link pills", () => {
  const linkSegs = (v: string) => splitLinkSegments(segs(v))

  it("pills a URL inside prose without dropping a character", () => {
    const value = "see https://github.com/svenstaro/genact now"
    const { container } = render(<ComposerChipOverlay value={value} segments={linkSegs(value)} />)
    const pills = container.querySelectorAll('[data-chip="link"]')
    expect(pills).toHaveLength(1)
    expect(pills[0].textContent).toBe("https://github.com/svenstaro/genact")
    // Conventional link styling — blue and underlined, no pill box.
    expect(pills[0].className).toMatch(/text-blue-600/)
    expect(pills[0].className).toMatch(/underline/)
    expect(container.textContent).toBe(value)
  })

  it("pills the link and the command on a link + command line", () => {
    const value = "https://github.com/a/b /help"
    const { container } = render(<ComposerChipOverlay value={value} segments={linkSegs(value)} />)
    expect(container.querySelectorAll('[data-chip="link"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(1)
    expect(container.textContent).toBe(value)
  })
})

describe("ComposerChipOverlay — the folded link's icon cell", () => {
  const marked = `${LINK_MARKER}svenstaro/genact`

  const segments = (value: string, url: string) =>
    splitLinkSegments(segs(value), [{ raw: marked, url, start: 0, end: marked.length }])

  it("paints the site's own mark into the first character", () => {
    const url = "https://github.com/svenstaro/genact"
    const { container } = render(
      <ComposerChipOverlay value={marked} segments={segments(marked, url)} />
    )
    const icon = container.querySelector("[data-link-icon]")!
    expect(icon).toHaveAttribute("data-link-icon", "brand")
    expect(icon.getAttribute("style")).toContain("github")
    // The cell is one real character, so the mirror still matches the textarea.
    expect(icon.textContent).toBe(LINK_MARKER)
    expect(container.textContent).toBe(marked)
  })

  it("falls back to a generic link glyph for a host with no mark", () => {
    const { container } = render(
      <ComposerChipOverlay
        value={marked}
        segments={segments(marked, "https://wiki.corp.example/x")}
      />
    )
    expect(container.querySelector("[data-link-icon]")).toHaveAttribute("data-link-icon", "generic")
  })
})
