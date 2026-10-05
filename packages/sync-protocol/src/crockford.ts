/**
 * Crockford base32, and the sync recovery key's display form (protocol §3.2).
 *
 * The recovery key is 16 bytes = 128 bits = 26 characters, the last carrying
 * two zero bits, shown as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`. Reading it back
 * forgives what people get wrong when copying by hand: case, hyphens and
 * spaces, `I`/`L` for `1` and `O` for `0`.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const INDEX = new Map([...ALPHABET].map((char, index) => [char, index]))

export const RECOVERY_KEY_BYTES = 16
export const RECOVERY_KEY_CHARS = 26

export function crockfordEncode(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >> bits) & 31]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31]
  return out
}

/** Upper-cases, drops separators and maps the confusable letters. */
export function normalizeCrockford(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")
}

/**
 * Decodes exactly `byteLength` bytes. Rejects a wrong length, a character
 * outside the alphabet (after normalizing) and non-zero padding bits, so a
 * typo can never decode to some other valid key.
 */
export function crockfordDecode(input: string, byteLength: number): Uint8Array {
  const chars = normalizeCrockford(input)
  if (chars.length !== Math.ceil((byteLength * 8) / 5)) {
    throw new Error(`expected ${Math.ceil((byteLength * 8) / 5)} characters`)
  }
  const out = new Uint8Array(byteLength)
  let buffer = 0
  let bits = 0
  let index = 0
  for (const char of chars) {
    const digit = INDEX.get(char)
    if (digit === undefined) throw new Error(`invalid character ${char}`)
    buffer = (buffer << 5) | digit
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[index++] = (buffer >> bits) & 0xff
    }
    buffer &= (1 << bits) - 1
  }
  if (buffer !== 0) throw new Error("non-zero padding bits")
  return out
}

export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new Error("a recovery key is 16 bytes")
  return (crockfordEncode(bytes).match(/.{1,4}/g) ?? []).join("-")
}

export function parseRecoveryKey(input: string): Uint8Array {
  return crockfordDecode(input, RECOVERY_KEY_BYTES)
}
