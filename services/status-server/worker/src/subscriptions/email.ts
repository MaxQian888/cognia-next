/**
 * Address normalisation and masking.
 *
 * Normalisation is conservative (plan §10): trim surrounding whitespace,
 * lowercase the domain and convert an internationalised domain to its ASCII
 * (punycode) form, and leave the local part exactly as typed, including
 * case and `+tags`, because only the receiving provider knows what its
 * local parts mean. Quoted or non-ASCII local parts are refused rather than
 * guessed at.
 */

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_ADDRESS = 254
const MAX_LOCAL = 64

function asciiDomain(domain: string): string | null {
  if (domain.length === 0 || domain.length > 253) return null
  if (domain.startsWith("[") || /^[\d.]+$/.test(domain)) return null
  let hostname: string
  try {
    hostname = new URL(`http://${domain}`).hostname
  } catch {
    return null
  }
  // URL parsing would accept a port, credentials or a path; insist the
  // hostname is the whole input (modulo case / IDNA / a trailing dot).
  const labels = hostname.replace(/\.$/, "").split(".")
  if (labels.length < 2) return null
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return null
  const tld = labels[labels.length - 1] ?? ""
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null
  return labels.join(".")
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ADDRESS) return null
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) return null
  const local = trimmed.slice(0, at)
  if (local.length > MAX_LOCAL || !LOCAL_PART.test(local)) return null
  if (/[/?#@:\\]/.test(trimmed.slice(at + 1))) return null
  const domain = asciiDomain(trimmed.slice(at + 1).toLowerCase())
  if (!domain) return null
  const address = `${local}@${domain}`
  return address.length <= MAX_ADDRESS ? address : null
}

/** `a•••@example.com`: enough for the owner to recognise, never the address. */
export function maskEmail(normalizedEmail: string): string {
  const at = normalizedEmail.lastIndexOf("@")
  if (at <= 0) return "•••"
  return `${normalizedEmail.slice(0, 1)}•••@${normalizedEmail.slice(at + 1)}`
}
