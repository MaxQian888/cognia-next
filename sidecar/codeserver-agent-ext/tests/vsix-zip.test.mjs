import assert from "node:assert/strict"
import test from "node:test"
import { inflateRawSync } from "node:zlib"

import { buildZip } from "../vsix-zip.mjs"

/**
 * Read an archive back through its central directory — the same way a VSIX
 * consumer resolves parts, rather than by scanning local headers.
 */
function readZip(buffer) {
  const eocd = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, "EOCD signature")
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "central directory signature")
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8")

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header for ${name}`)
    // Bit 3 would move the sizes into a trailing data descriptor, which a
    // streaming reader handles but many OPC readers do not.
    assert.equal(buffer.readUInt16LE(localOffset + 6) & 0x08, 0, `${name} has no data descriptor`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const extraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + extraLength
    const payload = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? payload : inflateRawSync(payload)
    assert.equal(data.length, uncompressedSize, `${name} declares its real size`)

    entries.push({ name, method, data })
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32)
  }
  return entries
}

const COMPRESSIBLE = Buffer.from("// extension\n".repeat(200))
const TINY = Buffer.from("{}")

test("round-trips every entry, in the order it was given", () => {
  const archive = buildZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types />") },
    { name: "extension.vsixmanifest", data: Buffer.from("<PackageManifest />") },
    { name: "extension/dist/extension.js", data: COMPRESSIBLE },
  ])
  const entries = readZip(archive)

  assert.deepEqual(
    entries.map((e) => e.name),
    ["[Content_Types].xml", "extension.vsixmanifest", "extension/dist/extension.js"]
  )
  assert.equal(entries[2].data.toString(), COMPRESSIBLE.toString())
})

test("stores an entry deflate would only make bigger", () => {
  const [stored, deflated] = readZip(
    buildZip([
      { name: "extension/package.json", data: TINY },
      { name: "extension/dist/proxy.js", data: COMPRESSIBLE },
    ])
  )
  assert.equal(stored.method, 0)
  assert.equal(stored.data.toString(), "{}")
  assert.equal(deflated.method, 8)
})

test("is byte-identical across runs, so a rebuild is not a diff", () => {
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types />") },
    { name: "extension/dist/extension.js", data: COMPRESSIBLE },
  ]
  assert.deepEqual(buildZip(entries), buildZip(entries))
  // The timestamp is the field the system `zip` varied; pin it explicitly so a
  // future edit cannot reintroduce a clock without failing here.
  const archive = buildZip(entries)
  assert.equal(archive.readUInt16LE(10), 0x0000, "DOS time")
  assert.equal(archive.readUInt16LE(12), 0x0021, "DOS date")
})

test("writes an empty archive rather than throwing", () => {
  const archive = buildZip([])
  assert.equal(archive.length, 22)
  assert.deepEqual(readZip(archive), [])
})
