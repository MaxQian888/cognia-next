import {
  extractHTMLEmbeddableContent,
  htmlToMarkdown,
  parseHTML,
  parseHTMLFile,
} from "./html-parser"

describe("parseHTML", () => {
  it("extracts metadata, structured content, links, images, tables, and text", async () => {
    const result = await parseHTML(
      `
        <html>
          <head>
            <title>Test Page</title>
            <meta name="description" content="Page description" />
            <meta name="keywords" content="test, html, parser" />
            <meta name="author" content="Test Author" />
            <meta property="og:title" content="OG Title" />
            <meta property="og:description" content="OG description" />
            <meta property="og:image" content="/og.png" />
            <style>body { color: red; }</style>
          </head>
          <body>
            <header>Hidden header</header>
            <main>
              <h1>Main Title</h1>
              <h2>Section</h2>
              <p>Visible content</p>
              <a href="/internal">Internal Link</a>
              <a href="https://external.example/page">External Link</a>
              <a href="https://external.example/page">Duplicate Link</a>
              <a href="#anchor">Anchor Link</a>
              <a href="javascript:alert('x')">Script Link</a>
              <img src="/image.png" alt="Image alt" title="Image title" />
              <img src="data:image/png;base64,AAAA" alt="Inline image" />
              <table>
                <caption>People</caption>
                <thead><tr><th>Name</th><th>Age</th></tr></thead>
                <tbody><tr><td>Jane</td><td>25</td></tr></tbody>
              </table>
            </main>
            <script>alert("hidden")</script>
          </body>
        </html>
      `,
      { baseUrl: "https://example.com/docs/" }
    )

    expect(result.title).toBe("Test Page")
    expect(result.metadata).toMatchObject({
      title: "Test Page",
      description: "Page description",
      keywords: ["test", "html", "parser"],
      author: "Test Author",
      ogTitle: "OG Title",
      ogDescription: "OG description",
      ogImage: "/og.png",
    })
    expect(result.headings).toEqual([
      { level: 1, text: "Main Title" },
      { level: 2, text: "Section" },
    ])
    expect(result.links).toEqual([
      {
        text: "Internal Link",
        href: "https://example.com/internal",
        isExternal: false,
      },
      {
        text: "External Link",
        href: "https://external.example/page",
        isExternal: true,
      },
    ])
    expect(result.images).toEqual([
      {
        src: "https://example.com/image.png",
        alt: "Image alt",
        title: "Image title",
      },
    ])
    expect(result.tables).toEqual([
      {
        caption: "People",
        headers: ["Name", "Age"],
        rows: [["Jane", "25"]],
      },
    ])
    expect(result.text).toContain("# Test Page")
    expect(result.text).toContain("Visible content")
    expect(result.text).toContain("Columns: Name, Age")
    expect(result.text).not.toContain("Hidden header")
    expect(result.text).not.toContain("alert")
  })

  it("honors extraction options and handles empty or invalid relative URLs", async () => {
    const result = await parseHTML(
      `
        <html>
          <body>
            <h1>Title</h1>
            <a href="/page"></a>
            <img src="/image.png" alt="" />
            <table><tr><td>Only row</td></tr></table>
          </body>
        </html>
      `,
      {
        includeLinks: false,
        includeImages: false,
        includeTables: false,
        baseUrl: "not a valid url",
      }
    )

    expect(result.title).toBeUndefined()
    expect(result.headings).toEqual([{ level: 1, text: "Title" }])
    expect(result.links).toEqual([])
    expect(result.images).toEqual([])
    expect(result.tables).toEqual([])

    const empty = await parseHTML("")
    expect(empty).toMatchObject({
      title: undefined,
      headings: [],
      links: [],
      images: [],
      tables: [],
    })
  })
})

describe("parseHTMLFile", () => {
  it("reads a File and delegates to parseHTML", async () => {
    const file = {
      text: async () => "<html><body><h1>File Title</h1></body></html>",
    } as File

    await expect(parseHTMLFile(file)).resolves.toMatchObject({
      headings: [{ level: 1, text: "File Title" }],
    })
  })
})

describe("extractHTMLEmbeddableContent", () => {
  it("combines title, description, and parsed text", () => {
    expect(
      extractHTMLEmbeddableContent({
        title: "Title",
        metadata: { description: "Description" },
        text: "Body text",
        headings: [],
        links: [],
        images: [],
        tables: [],
      })
    ).toBe("Title\n\nDescription\n\nBody text")
  })
})

describe("htmlToMarkdown", () => {
  it("converts common inline and block elements to markdown-like text", async () => {
    await expect(
      htmlToMarkdown(`
        <html>
          <body>
            <h1>Title</h1>
            <p>Paragraph with <strong>bold</strong>, <em>italic</em>, <code>code</code>.</p>
            <ul><li>First</li><li>Second</li></ul>
            <ol><li>One</li><li>Two</li></ol>
            <a href="https://example.com">Link</a>
          </body>
        </html>
      `)
    ).resolves.toContain("# Title")
  })
})
