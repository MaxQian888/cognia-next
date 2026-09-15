import fixtures from "@/protocol/image-reference-fixtures.json"

import {
  ImageReferenceError,
  canonicalImageReference,
  imageName,
  isValidImageDigest,
  parseImageReference,
} from "./image-reference"

interface FixtureCase {
  input: string
  ok?: { registry: string; repository: string; tag?: string; digest?: string; canonical: string }
  error?: string
}

const cases = (fixtures as { cases: FixtureCase[] }).cases

describe("parseImageReference", () => {
  it("has the shared fixture's cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    expect(cases.filter((entry) => entry.ok).length).toBeGreaterThan(5)
    expect(cases.filter((entry) => entry.error).length).toBeGreaterThan(5)
  })

  it.each(cases.filter((entry) => entry.ok).map((entry) => [entry.input, entry.ok!] as const))(
    "parses %j exactly as the Rust parser does",
    (input, expected) => {
      const reference = parseImageReference(input)
      expect(reference).toEqual({
        registry: expected.registry,
        repository: expected.repository,
        ...(expected.tag !== undefined ? { tag: expected.tag } : {}),
        ...(expected.digest !== undefined ? { digest: expected.digest } : {}),
      })
      expect(canonicalImageReference(reference)).toBe(expected.canonical)
    }
  )

  it.each(
    cases.filter((entry) => entry.error).map((entry) => [entry.input, entry.error!] as const)
  )("refuses %j as %s", (input, kind) => {
    let thrown: unknown
    try {
      parseImageReference(input)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ImageReferenceError)
    expect((thrown as ImageReferenceError).kind).toBe(kind)
  })

  it("never returns undefined-valued optional keys", () => {
    const reference = parseImageReference("node")
    expect(Object.keys(reference).sort()).toEqual(["registry", "repository"])
  })

  it("names and validates digests", () => {
    expect(imageName({ registry: "ghcr.io", repository: "acme/app" })).toBe("ghcr.io/acme/app")
    expect(isValidImageDigest(`sha256:${"a".repeat(64)}`)).toBe(true)
    expect(isValidImageDigest(`sha256:${"A".repeat(64)}`)).toBe(true)
    expect(isValidImageDigest(`sha256:${"a".repeat(63)}`)).toBe(false)
    expect(isValidImageDigest(`sha512:${"a".repeat(64)}`)).toBe(false)
  })
})
