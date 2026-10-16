/** @jest-environment jsdom */
import { nodeToMarkdown } from "./html-to-markdown"

const base = "https://example.com/posts/page"
function markdown(html: string): string {
  document.body.innerHTML = html
  return nodeToMarkdown(document.body, base)
}

describe("nodeToMarkdown", () => {
  afterEach(() => {
    document.head.innerHTML = ""
  })

  it("renders headings, inline marks, breaks, rules and nested quotes", () => {
    const result = markdown(
      "<h1>Title</h1><h6>Small</h6><p><strong>Bold</strong> <b>also</b> <em>em</em> <i>italic</i> <del>old</del><s>gone</s><br>next</p><hr><blockquote><p>outer</p><blockquote>inner</blockquote></blockquote>"
    )
    expect(result).toContain("# Title\n\n###### Small")
    expect(result).toContain("**Bold** **also** *em* *italic* ~~old~~~~gone~~\nnext")
    expect(result).toContain("\n\n---\n\n")
    expect(result).toContain("> outer")
    expect(result).toContain("> > inner")
  })

  it("excludes hidden ancestors, embedded content and every user input", () => {
    document.head.innerHTML = "<style>.concealed { display: none }</style>"
    expect(
      markdown(`<div class="concealed"><p>secret</p></div>
      <p style="visibility:hidden">secret</p><p style="opacity:0">secret</p>
      <p hidden>secret</p><p aria-hidden="true">secret</p>
      <input value="secret"><textarea>secret</textarea><select><option>secret</option></select>
      <button>secret</button><div contenteditable>secret</div><div contenteditable="plaintext-only">secret</div>
      <script>secret</script><style>secret</style><noscript>secret</noscript><template>secret</template>
      <iframe>secret</iframe><object>secret</object><embed><canvas>secret</canvas><svg><text>secret</text></svg>
      <audio>secret</audio><video>secret</video><p>Visible</p>`)
    ).toBe("Visible")
    const nested = document.querySelector(".concealed p")!
    expect(nodeToMarkdown(nested, base)).toBe("")
  })

  it("resolves links and images, removes unsafe schemes and tracking pixels", () => {
    const result =
      markdown(`<a href="../guide">guide</a> <a href="https://example.org/">https://example.org/</a>
      <a href="javascript:alert(1)">JS</a><a href="data:text/plain,secret">data</a><a href="vbscript:bad">VB</a>
      <img src="/image.png" alt="A [picture]"><img src="data:image/png,secret"><img src="/pixel" width="1" height="1">
      <img src="/css-pixel" style="width:1px;height:1px">`)
    expect(result).toContain("[guide](https://example.com/guide)")
    expect(result).toContain("<https://example.org/>")
    expect(result).toContain("JSdataVB")
    expect(result).toContain(String.raw`![A \[picture\]](https://example.com/image.png)`)
    expect(result).not.toMatch(/javascript:|vbscript:|data:|pixel/)
  })

  it("escapes page text so it cannot forge Markdown or HTML", () => {
    expect(
      markdown(
        "<p>*bold* _em_ `code` [link]</p><p># heading</p><p>&gt; quote</p><p>- list</p><p>+ list</p><p>1. list</p><p>&lt;script&gt;</p>"
      )
    ).toBe(
      [
        "\\*bold\\* \\_em\\_ \\`code\\` \\[link\\]",
        "\\# heading",
        "\\> quote",
        "\\- list",
        "\\+ list",
        "1\\. list",
        "&lt;script\\>",
      ].join("\n\n")
    )
  })

  it("collapses browser whitespace without losing word boundaries", () => {
    expect(markdown("<p> one\n  two <span> three </span> four </p><p>last</p>")).toBe(
      "one two three four\n\nlast"
    )
    expect(markdown("<p>one<b> bold </b>two</p>")).toBe("one **bold** two")
  })

  it("cannot forge a list or image by joining separate inline nodes", () => {
    expect(markdown('<p><span>1</span><span>. item</span></p><p>!<a href="/x">link</a></p>')).toBe(
      "1\\. item\n\n\\![link](https://example.com/x)"
    )
  })

  it("preserves code whitespace and language, choosing fences longer than embedded ticks", () => {
    const result = markdown(
      '<pre><code class="language-ts">const x = 1;\n\n\n  ```\n</code></pre><pre class="lang-py">  print(1)</pre><p><code>a`b</code></p>'
    )
    expect(result).toContain("````ts\nconst x = 1;\n\n\n  ```\n````")
    expect(result).toContain("```py\n  print(1)\n```")
    expect(result).toContain("``a`b``")
  })

  it("renders nested ordered and unordered lists with start values", () => {
    const result = markdown(
      '<ol start="3"><li>third<ul><li>child<ol start="7"><li>deep</li></ol></li></ul></li><li>fourth</li></ol>'
    )
    expect(result).toMatch(/^3\. third/)
    expect(result).toContain("\n   - child")
    expect(result).toContain("\n     7. deep")
    expect(result).toContain("\n4. fourth")
  })

  it("renders tables with header precedence, escaped pipes, collapsed cells and colspan", () => {
    const result = markdown(
      '<table><thead><tr><th>Key | name</th><th colspan="2">Value</th></tr></thead><tbody><tr><td>one\n two</td><td><strong>bold</strong></td><td>three</td></tr></tbody></table>'
    )
    expect(result).toBe(
      "| Key \\| name | Value |  |\n| --- | --- | --- |\n| one two | **bold** | three |"
    )
    expect(markdown("<table><tr><td>First</td></tr><tr><td>Second</td></tr></table>")).toBe(
      "| First |\n| --- |\n| Second |"
    )
    expect(markdown("<table><tr><td><code>a|b</code></td></tr></table>")).toBe(
      "| `a\\|b` |\n| --- |"
    )
  })

  it("keeps figures, captions and definition lists", () => {
    const result = markdown(
      '<figure><img src="/x" alt="X"><figcaption>Caption</figcaption></figure><dl><dt>Term</dt><dd>Definition</dd></dl>'
    )
    expect(result).toBe("![X](https://example.com/x)\n\nCaption\n\n**Term**\n\nDefinition")
  })

  it("works with a detached document that has no computed style API", () => {
    const doc = document.implementation.createHTMLDocument("Other")
    doc.body.innerHTML = "<h2>Detached</h2><p hidden>secret</p>"
    expect(nodeToMarkdown(doc.body, base)).toBe("## Detached")
  })
})
