import test from "node:test"
import assert from "node:assert/strict"

import {
  consoleDecoderLabel,
  decodeConsoleBytes,
  pickStreamDecoder,
  __resetConsoleDecoderCache,
} from "./console-decode.mjs"

test("decodeConsoleBytes round-trips valid UTF-8 unchanged", () => {
  __resetConsoleDecoderCache()
  const buf = Buffer.from("héllo 中文 🎉", "utf8")
  assert.equal(decodeConsoleBytes(buf), "héllo 中文 🎉")
})

test("decodeConsoleBytes never throws on invalid UTF-8 (OEM fallback)", () => {
  __resetConsoleDecoderCache()
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // 中文 in GBK, invalid UTF-8
  const out = decodeConsoleBytes(gbk)
  assert.equal(typeof out, "string")
  assert.ok(out.length > 0)
  if (consoleDecoderLabel() === "gbk") assert.equal(out, "中文")
})

test("pickStreamDecoder decodes a multibyte char split across chunks", () => {
  // "中" = e4 b8 ad in UTF-8; split after the second byte.
  const head = Buffer.from([0xe4, 0xb8])
  const tail = Buffer.from([0xad])
  const dec = pickStreamDecoder(head)
  let s = dec.decode(head, { stream: true })
  s += dec.decode(tail, { stream: true })
  s += dec.decode()
  assert.equal(s, "中")
})

test("consoleDecoderLabel resolves a non-empty label (utf-8 off Windows)", () => {
  __resetConsoleDecoderCache()
  const label = consoleDecoderLabel()
  assert.equal(typeof label, "string")
  assert.ok(label.length > 0)
  if (process.platform !== "win32") assert.equal(label, "utf-8")
})
