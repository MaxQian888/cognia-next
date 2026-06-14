import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fsp from "node:fs/promises"

import {
  modelInputModalities,
  modelSupportsImageInput,
  imageMimeFor,
  readImageBlock,
  renderNotebook,
  editNotebook,
  splitNotebookSource,
  extractPdfText,
  MAX_IMAGE_BYTES,
} from "./read-media.mjs"

/** A hand-built minimal single-page PDF carrying the text "Hello PDF World". */
export const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 46>>stream
BT /F1 18 Tf 20 120 Td (Hello PDF World) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

test("modelInputModalities resolves a known model and gateway id", () => {
  const direct = modelInputModalities("anthropic", "claude-opus-4-5")
  assert.ok(direct.includes("image"))
  // Gateway-style "org/model" id.
  const viaOrg = modelInputModalities("gateway", "anthropic/claude-opus-4-5")
  assert.ok(viaOrg.includes("image"))
  assert.deepEqual(modelInputModalities("nope", "does-not-exist"), [])
})

test("modelSupportsImageInput gates on the image modality", () => {
  assert.equal(modelSupportsImageInput("anthropic", "claude-opus-4-5"), true)
  assert.equal(modelSupportsImageInput("", ""), false)
  assert.equal(modelSupportsImageInput("anthropic", undefined), false)
})

test("imageMimeFor maps known image extensions only", () => {
  assert.equal(imageMimeFor("/x/a.PNG"), "image/png")
  assert.equal(imageMimeFor("/x/a.jpeg"), "image/jpeg")
  assert.equal(imageMimeFor("/x/a.svg"), null) // svg is text, not inlined
  assert.equal(imageMimeFor("/x/a.txt"), null)
})

test("readImageBlock encodes an image to base64", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "readmedia-"))
  const p = path.join(dir, "pixel.png")
  await fsp.writeFile(p, PNG_1X1)
  const r = await readImageBlock(p)
  assert.equal(r.ok, true)
  assert.equal(r.mimeType, "image/png")
  assert.equal(r.data, PNG_1X1.toString("base64"))
})

test("readImageBlock rejects unsupported ext and oversize files", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "readmedia-"))
  const txt = path.join(dir, "a.txt")
  await fsp.writeFile(txt, "hi")
  assert.deepEqual(await readImageBlock(txt), { ok: false, reason: "unsupported" })

  const big = path.join(dir, "big.png")
  await fsp.writeFile(big, Buffer.alloc(MAX_IMAGE_BYTES + 1, 0))
  const r = await readImageBlock(big)
  assert.equal(r.ok, false)
  assert.equal(r.reason, "too_large")
})

test("renderNotebook renders markdown + code cells and outputs", () => {
  const nb = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "text"] },
      {
        cell_type: "code",
        source: ["print('hi')\n"],
        outputs: [
          { output_type: "stream", text: ["hi\n"] },
          { output_type: "execute_result", data: { "text/plain": ["42"] } },
          { output_type: "error", ename: "ValueError", evalue: "boom" },
        ],
      },
    ],
  })
  const text = renderNotebook(nb)
  assert.match(text, /Cell 1 \[markdown\]/)
  assert.match(text, /# Title/)
  assert.match(text, /Cell 2 \[code\]/)
  assert.match(text, /print\('hi'\)/)
  assert.match(text, /Output:/)
  assert.match(text, /hi/)
  assert.match(text, /42/)
  assert.match(text, /ValueError: boom/)
})

test("renderNotebook handles empty + string-source cells", () => {
  assert.match(renderNotebook(JSON.stringify({ cells: [] })), /empty notebook/)
  const nb = JSON.stringify({ cells: [{ cell_type: "code", source: "x = 1" }] })
  assert.match(renderNotebook(nb), /x = 1/)
})

test("renderNotebook throws on malformed JSON", () => {
  assert.throws(() => renderNotebook("{not json"))
})

test("splitNotebookSource keeps trailing newlines per nbformat", () => {
  assert.deepEqual(splitNotebookSource("a\nb"), ["a\n", "b"])
  assert.deepEqual(splitNotebookSource("a\nb\n"), ["a\n", "b\n"])
  assert.deepEqual(splitNotebookSource(""), [])
})

function nb(cells) {
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)
}

test("editNotebook replace overwrites a code cell source and clears outputs", () => {
  const src = nb([
    {
      cell_type: "code",
      id: "c1",
      source: ["old\n"],
      outputs: [{ output_type: "stream", text: ["x"] }],
      execution_count: 3,
    },
  ])
  const r = editNotebook(src, { cellId: "c1", source: "new = 2" })
  const out = JSON.parse(r.json)
  assert.deepEqual(out.cells[0].source, ["new = 2"])
  assert.deepEqual(out.cells[0].outputs, [])
  assert.equal(out.cells[0].execution_count, null)
  assert.match(r.message, /Replaced/)
})

test("editNotebook replace can change cell type to markdown", () => {
  const src = nb([
    { cell_type: "code", id: "c1", source: ["x\n"], outputs: [], execution_count: null },
  ])
  const r = editNotebook(src, { cellId: "c1", source: "# heading", cellType: "markdown" })
  const out = JSON.parse(r.json)
  assert.equal(out.cells[0].cell_type, "markdown")
  assert.equal(out.cells[0].outputs, undefined)
  assert.equal(out.cells[0].execution_count, undefined)
})

test("editNotebook locates by 1-based cell_number", () => {
  const src = nb([
    { cell_type: "code", id: "a", source: ["1\n"] },
    { cell_type: "code", id: "b", source: ["2\n"] },
  ])
  const r = editNotebook(src, { cellNumber: 2, source: "changed" })
  const out = JSON.parse(r.json)
  assert.deepEqual(out.cells[1].source, ["changed"])
})

test("editNotebook insert adds a cell after the locator, or at top without one", () => {
  const src = nb([{ cell_type: "code", id: "a", source: ["1\n"] }])
  const after = editNotebook(src, { cellId: "a", source: "print(2)", mode: "insert" })
  let out = JSON.parse(after.json)
  assert.equal(out.cells.length, 2)
  assert.deepEqual(out.cells[1].source, ["print(2)"])
  assert.equal(out.cells[1].cell_type, "code")

  const top = editNotebook(src, { source: "top", cellType: "markdown", mode: "insert" })
  out = JSON.parse(top.json)
  assert.equal(out.cells[0].cell_type, "markdown")
  assert.deepEqual(out.cells[0].source, ["top"])
})

test("editNotebook delete removes the located cell", () => {
  const src = nb([
    { cell_type: "code", id: "a", source: ["1\n"] },
    { cell_type: "code", id: "b", source: ["2\n"] },
  ])
  const r = editNotebook(src, { cellId: "b", mode: "delete" })
  const out = JSON.parse(r.json)
  assert.equal(out.cells.length, 1)
  assert.equal(out.cells[0].id, "a")
  assert.match(r.message, /Deleted/)
})

test("editNotebook throws on bad JSON, unresolved locator, and missing source", () => {
  assert.throws(() => editNotebook("{bad", { cellId: "a", source: "x" }))
  assert.throws(() => editNotebook(nb([]), { cellId: "missing", source: "x" }), /could not locate/)
  assert.throws(
    () => editNotebook(nb([{ cell_type: "code", id: "a", source: [] }]), { cellId: "a" }),
    /requires new_source/
  )
})

test("extractPdfText pulls page text from a real PDF", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "readpdf-"))
  const p = path.join(dir, "hello.pdf")
  await fsp.writeFile(p, MINIMAL_PDF, "latin1")
  const r = await extractPdfText(p)
  assert.equal(r.ok, true)
  assert.equal(r.pages, 1)
  assert.match(r.text, /Hello PDF World/)
  assert.match(r.text, /# Page 1/)
})

test("extractPdfText fails gracefully on a non-PDF", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "readpdf-"))
  const p = path.join(dir, "not.pdf")
  await fsp.writeFile(p, "this is plainly not a pdf")
  const r = await extractPdfText(p)
  assert.equal(r.ok, false)
})
