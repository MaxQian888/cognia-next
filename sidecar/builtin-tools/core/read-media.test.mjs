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
  MAX_IMAGE_BYTES,
} from "./read-media.mjs"

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
