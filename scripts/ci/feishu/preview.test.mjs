import assert from "node:assert/strict"
import test from "node:test"
import { renderPreview } from "./preview.mjs"
import { renderCard } from "./transport.mjs"

function payload(overrides = {}) {
  return {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      header: {
        title: { tag: "plain_text", content: "CI/CD Pipeline failed" },
        subtitle: { tag: "plain_text", content: "Cognia · dev · aabbccddeeff" },
        template: "red",
        text_tag_list: [
          {
            tag: "text_tag",
            text: { tag: "plain_text", content: "Needs attention" },
            color: "red",
          },
        ],
      },
      body: {
        elements: [
          {
            tag: "column_set",
            columns: [
              {
                tag: "column",
                background_style: "metric-surface",
                elements: [
                  {
                    tag: "div",
                    text: { tag: "plain_text", content: "Completed", text_size: "notation" },
                  },
                  {
                    tag: "div",
                    text: { tag: "plain_text", content: "12 passed", text_size: "heading-2" },
                  },
                ],
              },
              {
                tag: "column",
                background_style: "metric-surface",
                elements: [
                  {
                    tag: "div",
                    text: { tag: "plain_text", content: "Attention", text_size: "notation" },
                  },
                  {
                    tag: "div",
                    text: { tag: "plain_text", content: "2 failed", text_size: "heading-2" },
                  },
                ],
              },
            ],
          },
          { tag: "hr" },
          {
            tag: "div",
            text: { tag: "plain_text", content: "Jest · 142 tests\nPlaywright · 28 tests" },
          },
          {
            tag: "column_set",
            flex_mode: "flow",
            columns: [
              {
                tag: "column",
                width: "auto",
                elements: [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: "View workflow" },
                    type: "primary_filled",
                    behaviors: [
                      {
                        type: "open_url",
                        default_url: "https://github.com/owner/repo/actions/runs/42",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      ...overrides,
    },
  }
}

test("renders actual Card2 header, tags, metrics, sections and GitHub action into standalone HTML", () => {
  const html = renderPreview(payload())
  for (const value of [
    "CI/CD Pipeline failed",
    "Cognia · dev · aabbccddeeff",
    "Needs attention",
    "12 passed",
    "2 failed",
    "Jest · 142 tests",
    "View workflow",
  ])
    assert.ok(html.includes(value))
  assert.match(html, /href="https:\/\/github.com\/owner\/repo\/actions\/runs\/42"/)
  assert.match(html, /class="card status-red"/)
  assert.match(html, /class="column metric"/)
  assert.match(html, /class="text text-heading-2"/)
  assert.match(html, /class="actions"/)
  assert.match(html, /class="button button-primary"/)
  assert.match(html, /Local layout preview · verify final appearance in Feishu/)
  assert.match(html, /<hr/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /default-src 'none'/)
  assert.doesNotMatch(html, /<script|<iframe|<img|@import|url\(/i)
})

test("escapes hostile text and permits only GitHub HTTPS action URLs", () => {
  const sample = payload()
  sample.card.header.title.content = '</title><script>alert("x")</script>'
  sample.card.header.template = 'red" onclick="alert(1)'
  sample.card.body.elements = [
    { tag: "div", text: { tag: "plain_text", content: '<img src=x onerror="alert(1)">' } },
    ...[
      "javascript:alert(1)",
      "https://github.com.evil.example/a",
      "https://github.com@evil.example/a",
      'https://github.com/evil" onclick="alert(1)',
      "https://example.com",
    ].map((default_url) => ({
      tag: "button",
      text: { tag: "plain_text", content: "Unsafe button" },
      behaviors: [{ type: "open_url", default_url }],
    })),
  ]
  const html = renderPreview(sample)
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"))
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"))
  assert.doesNotMatch(html, /<script|<img|href=|class="card status-red" onclick=/)
  assert.match(html, /class="card status-blue"/)
})

test("responsive card uses bounded widths and compact columns for mobile previews", () => {
  const html = renderPreview(payload())
  assert.match(html, /name="viewport"/)
  assert.match(html, /@media \(max-width: 480px\)/)
  assert.match(html, /minmax\(0, 1fr\)/)
  assert.match(html, /overflow-wrap: anywhere/)
  assert.match(html, /max-width: 680px/)
})

test("uses typography nested in actual emitted Card2 text objects", () => {
  const html = renderPreview(
    renderCard({
      title: "CI evidence",
      metrics: [{ label: "Passed jobs", value: "12" }],
      sections: [{ title: "Change context", lines: ["dev · abc123"] }],
      footer: "Read the full result",
    })
  )
  assert.match(html, /class="text text-notation muted">Passed jobs/)
  assert.match(html, /class="text text-heading-2">12/)
  assert.match(html, /class="text text-heading-4">Change context/)
  assert.match(html, /class="text text-notation muted">Read the full result/)
})

test("unsupported elements and non-Card2 payloads are explicit rather than falsely verified", () => {
  assert.throws(() => renderPreview({ card: { schema: "1.0" } }), /Card JSON 2.0/)
  const html = renderPreview(payload({ body: { elements: [{ tag: "chart<script>" }] } }))
  assert.match(html, /Unsupported preview element: chart&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})
