import type { ShareProvenance } from "@/lib/share/types"

const encoder = new TextEncoder()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value)
}

/** Insert a deterministic PNG tEXt chunk before IEND. */
export async function embedPngTwinProvenance(
  blob: Blob,
  provenance: readonly ShareProvenance[] | undefined
): Promise<Blob> {
  const twin = provenance?.filter((entry) => entry.source === "digital-twin") ?? []
  if (twin.length === 0) return blob
  const source = new Uint8Array(await blob.arrayBuffer())
  const iend = encoder.encode("IEND")
  let insertAt = -1
  for (let offset = 8; offset + 12 <= source.length;) {
    const length = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(
      offset
    )
    const typeAt = offset + 4
    if (iend.every((byte, index) => source[typeAt + index] === byte)) {
      insertAt = offset
      break
    }
    offset += 12 + length
  }
  if (insertAt < 0) return blob

  const type = encoder.encode("tEXt")
  const data = encoder.encode(`cognia.provenance\0${JSON.stringify(twin)}`)
  const chunk = new Uint8Array(12 + data.length)
  writeUint32(chunk, 0, data.length)
  chunk.set(type, 4)
  chunk.set(data, 8)
  writeUint32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))

  const output = new Uint8Array(source.length + chunk.length)
  output.set(source.subarray(0, insertAt), 0)
  output.set(chunk, insertAt)
  output.set(source.subarray(insertAt), insertAt + chunk.length)
  return new Blob([output], { type: "image/png" })
}
