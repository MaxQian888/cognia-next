import { test } from "node:test"
import assert from "node:assert/strict"

import { builtinToModelOutput, callToolResultToText, hasRichContentBlock } from "./ai-sdk-output.ts"

test("callToolResultToText joins text blocks and falls back to JSON", () => {
  assert.equal(
    callToolResultToText({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "QQ==" },
        null,
        { type: "text", text: "b" },
      ],
    }),
    "a\nb"
  )
  assert.equal(callToolResultToText(null), "")
  assert.equal(callToolResultToText(undefined), "")
  assert.equal(callToolResultToText("plain"), "plain")
  assert.equal(callToolResultToText({ ok: true }), '{"ok":true}')
})

test("hasRichContentBlock is true only for image, audio and resource blocks", () => {
  for (const type of ["image", "audio", "resource", "resource_link"]) {
    assert.equal(hasRichContentBlock({ content: [{ type: "text" }, { type }] }), true, type)
  }
  assert.equal(hasRichContentBlock({ content: [{ type: "text", text: "x" }, null] }), false)
  assert.equal(hasRichContentBlock("plain"), false)
  assert.equal(hasRichContentBlock(null), false)
})

test("builtinToModelOutput maps a plain string result to a text output", () => {
  assert.deepEqual(builtinToModelOutput({ output: "hello" }), { type: "text", value: "hello" })
})

test("builtinToModelOutput maps an MCP image block to a canonical file content part", () => {
  const out = builtinToModelOutput({
    output: {
      content: [
        { type: "text", text: "screenshot.png (12 bytes)" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    },
  })
  assert.deepEqual(out, {
    type: "content",
    value: [
      { type: "text", text: "screenshot.png (12 bytes)" },
      // AI SDK 7 canonical shape: one `file` part with a tagged data union.
      // The `media` and `image-data` variants are both gone.
      { type: "file", mediaType: "image/png", data: { type: "data", data: "QUJD" } },
    ],
  })
})

test("builtinToModelOutput routes non-image media to a canonical file part", () => {
  const out = builtinToModelOutput({
    output: { content: [{ type: "image", data: "QQ==", mimeType: "audio/wav" }] },
  })
  assert.deepEqual(out, {
    type: "content",
    value: [{ type: "file", mediaType: "audio/wav", data: { type: "data", data: "QQ==" } }],
  })
})

test("builtinToModelOutput maps audio and embedded resources, with default media types", () => {
  const out = builtinToModelOutput({
    output: {
      content: [
        { type: "image", data: "SU1H" },
        { type: "audio", data: "QVVE" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "inline text" } },
        { type: "resource", resource: { uri: "file:///b.bin", blob: "QklO", title: "b.bin" } },
        {
          type: "resource",
          resource: {
            uri: "file:///c.pdf",
            blob: "UERG",
            mimeType: "application/pdf",
            name: "c.pdf",
          },
        },
        // Blocks without a payload are dropped.
        { type: "image" },
        { type: "resource", resource: { uri: "file:///empty" } },
      ],
    },
  })
  assert.deepEqual(out, {
    type: "content",
    value: [
      { type: "file", mediaType: "image/png", data: { type: "data", data: "SU1H" } },
      { type: "file", mediaType: "audio/mpeg", data: { type: "data", data: "QVVE" } },
      { type: "text", text: "inline text" },
      {
        type: "file",
        mediaType: "application/octet-stream",
        data: { type: "data", data: "QklO" },
        filename: "b.bin",
      },
      {
        type: "file",
        mediaType: "application/pdf",
        data: { type: "data", data: "UERG" },
        filename: "c.pdf",
      },
    ],
  })
})

test("resource links remain visible text without authorizing provider-side fetches", () => {
  const output = builtinToModelOutput({
    output: {
      content: [
        { type: "resource_link", uri: "https://example.test/manual.pdf", name: "Manual" },
        { type: "resource_link", uri: "https://example.test/guide", title: "Guide" },
        { type: "resource_link", uri: "https://example.test/bare" },
      ],
    },
  })

  assert.deepEqual(output, {
    type: "content",
    value: [
      { type: "text", text: "Manual: https://example.test/manual.pdf" },
      { type: "text", text: "Guide: https://example.test/guide" },
      { type: "text", text: "https://example.test/bare" },
    ],
  })
})
