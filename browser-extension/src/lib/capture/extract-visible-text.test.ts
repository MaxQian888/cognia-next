/** @jest-environment jsdom */
import { extractFromDocument } from "./extract-visible-text"

function page(html: string): void {
  document.body.innerHTML = html
}

/**
 * jsdom does not do layout, so `getComputedStyle` returns whatever the inline
 * style says and nothing more. That is enough for these assertions — every
 * exclusion the extractor makes is driven by an inline style, an attribute or
 * a tag name, none of which need a layout engine — and it is why the extractor
 * checks those rather than, say, `getBoundingClientRect`.
 */
describe("extractFromDocument", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    document.title = "A page"
  })

  it("returns the visible text of the page", () => {
    page("<p>Hello</p><p>World</p>")
    const result = extractFromDocument(true)
    expect(result.readableText).toBe("Hello\nWorld")
    expect(result.title).toBe("A page")
  })

  it("reads nothing but metadata unless the whole page is asked for", () => {
    page("<p>Hello</p>")
    const result = extractFromDocument(false)
    expect(result.readableText).toBeNull()
    expect(result.readableCharacterCount).toBe(0)
    expect(result.title).toBe("A page")
  })

  it("never includes what the user typed", () => {
    // Form controls hold the user's input, not the page's content, and are the
    // most likely place for a credential or a card number.
    page(`
      <input type="password" value="hunter2" />
      <input type="text" value="my draft" />
      <textarea>a reply I have not sent</textarea>
      <select><option>chosen</option></select>
      <p>Visible</p>
    `)
    const text = extractFromDocument(true).readableText ?? ""
    expect(text).toContain("Visible")
    for (const secret of ["hunter2", "my draft", "a reply I have not sent", "chosen"]) {
      expect(text).not.toContain(secret)
    }
  })

  it("never includes what the user is editing", () => {
    page('<div contenteditable="true">unsent comment</div><p>Visible</p>')
    const text = extractFromDocument(true).readableText ?? ""
    expect(text).toContain("Visible")
    expect(text).not.toContain("unsent comment")
  })

  it("skips hidden elements however they are hidden", () => {
    page(`
      <div style="display: none">display none</div>
      <div style="visibility: hidden">visibility hidden</div>
      <div style="opacity: 0">fully transparent</div>
      <div aria-hidden="true">aria hidden</div>
      <div hidden>hidden attribute</div>
      <p>Visible</p>
    `)
    const text = extractFromDocument(true).readableText ?? ""
    expect(text).toBe("Visible")
  })

  it("skips text inside a hidden ancestor two levels up", () => {
    // Collapsed menus are built this way. Checking only the parent would let
    // an entire hidden navigation tree into the capture.
    page('<div style="display: none"><section><p>menu item</p></section></div><p>Visible</p>')
    expect(extractFromDocument(true).readableText).toBe("Visible")
  })

  it("skips script, style and embedded frames", () => {
    page(`
      <script>var secret = 1</script>
      <style>.a { color: red }</style>
      <noscript>enable js</noscript>
      <iframe srcdoc="<p>framed</p>"></iframe>
      <p>Visible</p>
    `)
    const text = extractFromDocument(true).readableText ?? ""
    expect(text).toBe("Visible")
  })

  it("normalizes whitespace without gluing blocks together", () => {
    page("<p>one    two</p>\n\n\n<p>three</p>")
    expect(extractFromDocument(true).readableText).toBe("one two\nthree")
  })

  it("reports the character count of what it actually extracted", () => {
    page('<p>Visible</p><div style="display:none">a very long hidden block</div>')
    const result = extractFromDocument(true)
    expect(result.readableCharacterCount).toBe("Visible".length)
  })

  it("returns null rather than an empty string for a page with no text", () => {
    // The difference matters downstream: `null` means "no page text", and an
    // empty string would be sent as a `readable-page` capture of nothing.
    page('<div style="display:none">hidden</div>')
    expect(extractFromDocument(true).readableText).toBeNull()
  })
})
