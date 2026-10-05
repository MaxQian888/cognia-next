/**
 * PADMÉ padding (protocol §7.4): an op's plaintext grows to the next bucket
 * before encryption, so ciphertext lengths leak at most O(log log n) bits.
 * The plaintext ends with `0x80` and then zeros up to the bucket.
 */

/** The PADMÉ bucket for `length` bytes. */
export function padmeLength(length: number): number {
  if (!Number.isInteger(length) || length < 0 || length > 0x7fffffff)
    throw new RangeError("invalid length")
  if (length < 2) return length
  const e = 31 - Math.clz32(length)
  const s = 32 - Math.clz32(e)
  const mask = (1 << (e - s)) - 1
  return (length + mask) & ~mask
}

export function pad(plaintext: Uint8Array): Uint8Array {
  const padded = new Uint8Array(padmeLength(plaintext.length + 1))
  padded.set(plaintext)
  padded[plaintext.length] = 0x80
  return padded
}

export function unpad(padded: Uint8Array): Uint8Array {
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (end < 0 || padded[end] !== 0x80) throw new RangeError("bad padding")
  return padded.slice(0, end)
}
