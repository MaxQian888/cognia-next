/**
 * OCI image references, parsed exactly as `crates/cognia-environment/src/image.rs`
 * parses them (ADR-0182).
 *
 * A repository declaration names an image as free text (`node:22`,
 * `ghcr.io/acme/dev@sha256:…`). The brain normalises it before digesting the
 * declaration and before asking the Host to resolve it, and the Host matches
 * the normalised parts against its registry allowlist. If the two parsers
 * disagreed on `docker.io/library/` or on where a tag starts, an approval would
 * cover a different image than the one admission checks — so both run
 * `protocol/image-reference-fixtures.json`.
 */

export const DEFAULT_REGISTRY = "docker.io"
export const DIGEST_PREFIX = "sha256:"
const MAX_REFERENCE_BYTES = 512
const MAX_REPOSITORY_LENGTH = 255

export type ImageReferenceErrorKind =
  | "empty"
  | "too-long"
  | "invalid-registry"
  | "invalid-repository"
  | "invalid-tag"
  | "invalid-digest"

export class ImageReferenceError extends Error {
  constructor(
    readonly kind: ImageReferenceErrorKind,
    readonly value: string
  ) {
    super(`${kind}: ${value}`)
    this.name = "ImageReferenceError"
  }
}

export interface ImageReference {
  registry: string
  repository: string
  tag?: string
  /** Lowercased `sha256:<hex>`. */
  digest?: string
}

export function parseImageReference(input: string): ImageReference {
  const trimmed = input.trim()
  if (!trimmed) throw new ImageReferenceError("empty", input)
  if (new TextEncoder().encode(trimmed).length > MAX_REFERENCE_BYTES) {
    throw new ImageReferenceError("too-long", trimmed.slice(0, 64))
  }

  let nameAndTag = trimmed
  let digest: string | undefined
  const at = trimmed.indexOf("@")
  if (at !== -1) {
    nameAndTag = trimmed.slice(0, at)
    const rawDigest = trimmed.slice(at + 1)
    validateDigest(rawDigest)
    digest = rawDigest.toLowerCase()
  }

  // A tag is after the LAST colon, but only when that colon follows the last
  // slash — `localhost:5000/app` has a port, not a tag.
  const lastSlash = nameAndTag.lastIndexOf("/")
  const lastColon = nameAndTag.lastIndexOf(":")
  let name = nameAndTag
  let tag: string | undefined
  if (lastColon !== -1 && lastColon > lastSlash) {
    name = nameAndTag.slice(0, lastColon)
    tag = nameAndTag.slice(lastColon + 1)
    if (!isValidTag(tag)) throw new ImageReferenceError("invalid-tag", tag)
  }

  let registry = DEFAULT_REGISTRY
  let repository = name
  const slash = name.indexOf("/")
  if (slash !== -1) {
    const first = name.slice(0, slash)
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first.toLowerCase()
      repository = name.slice(slash + 1)
    }
  }
  if (!isValidRegistry(registry)) throw new ImageReferenceError("invalid-registry", registry)
  if (registry === DEFAULT_REGISTRY && !repository.includes("/")) {
    repository = `library/${repository}`
  }
  if (!isValidRepository(repository)) {
    throw new ImageReferenceError("invalid-repository", repository)
  }

  return {
    registry,
    repository,
    ...(tag !== undefined ? { tag } : {}),
    ...(digest !== undefined ? { digest } : {}),
  }
}

/** `registry/repository`, what registry allowlists match on. */
export function imageName(reference: Pick<ImageReference, "registry" | "repository">): string {
  return `${reference.registry}/${reference.repository}`
}

/** Digest when pinned, else the tag, else `latest` (what a registry resolves). */
export function canonicalImageReference(reference: ImageReference): string {
  if (reference.digest) return `${imageName(reference)}@${reference.digest}`
  return `${imageName(reference)}:${reference.tag ?? "latest"}`
}

export function isValidImageDigest(value: string): boolean {
  if (!value.startsWith(DIGEST_PREFIX)) return false
  return /^[0-9a-fA-F]{64}$/.test(value.slice(DIGEST_PREFIX.length))
}

function validateDigest(value: string): void {
  if (!isValidImageDigest(value)) throw new ImageReferenceError("invalid-digest", value)
}

function isValidRegistry(registry: string): boolean {
  const colon = registry.lastIndexOf(":")
  const host = colon === -1 ? registry : registry.slice(0, colon)
  if (colon !== -1) {
    // Rust's `u16` parse: digits with an optional leading `+`.
    const port = registry.slice(colon + 1)
    if (!/^\+?\d+$/.test(port) || Number(port) > 65535) return false
  }
  return host === "localhost" || (host.includes(".") && isValidHostname(host))
}

/** `cognia_net::egress::is_valid_hostname`: an IP literal or DNS labels. */
function isValidHostname(host: string): boolean {
  if (isIpLiteral(host)) return true
  if (!host || host.length > 253) return false
  const core = host.endsWith(".") ? host.slice(0, -1) : host
  if (!core) return false
  return core
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9-]+$/.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-")
    )
}

/** What Rust's `str::parse::<IpAddr>` accepts. */
function isIpLiteral(host: string): boolean {
  const octets = host.split(".")
  if (
    octets.length === 4 &&
    // Strict dotted decimal: no leading zeros, each octet at most 255.
    octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  ) {
    return true
  }
  if (!host.includes(":") || /[[\]%]/.test(host)) return false
  try {
    // The WHATWG IPv6 parser agrees with Rust's on the forms that matter
    // (compression, embedded IPv4) and throws on everything else.
    new URL(`http://[${host}]/`)
    return true
  } catch {
    return false
  }
}

/**
 * Path components of `[a-z0-9]` separated by `.`, `_`, `__` or runs of `-`,
 * joined by `/`; at most 255 characters.
 */
function isValidRepository(repository: string): boolean {
  if (!repository || repository.length > MAX_REPOSITORY_LENGTH) return false
  return repository
    .split("/")
    .every((component) => /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/.test(component))
}

/** `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`. */
function isValidTag(tag: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)
}
