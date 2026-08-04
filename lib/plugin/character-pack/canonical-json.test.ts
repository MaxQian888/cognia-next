import { createPublicKey, verify } from "node:crypto"

import {
  canonicalizeJson,
  canonicalJsonBytes,
  canonicalPackBytes,
  canonicalPackString,
  CanonicalJsonError,
} from "./canonical-json"
import vectorFile from "./__fixtures__/jcs-vectors.json"
import rustSignedPack from "./__fixtures__/rust-signed-pack.json"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

describe("golden vectors (shared with the Rust signer)", () => {
  // This exact fixture is also `include_str!`d by
  // crates/cognia-cli/src/engine/canonical_json.rs. If the two sides ever
  // disagree, signed packs verify on one and not the other.
  it.each(vectorFile.vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    expect(canonicalizeJson(vector.input)).toBe(vector.expected)
  })

  it("covers the UTF-16 key-ordering trap explicitly", () => {
    // U+1F602 is encoded as the surrogate pair D83D DE02. Its LEAD unit
    // (0xD83D) is below U+FB33, so UTF-16 code-unit order — which RFC 8785
    // §3.2.3 mandates — puts the emoji first. Sorting by code point, or by
    // UTF-8 bytes, produces the opposite order and a signature nobody can
    // verify. Escapes rather than literals here: the precomposed U+FB33 and
    // its decomposed form (U+05E8 U+05BC) look identical in an editor but sort
    // differently, which is its own way to get this test silently wrong.
    const out = canonicalizeJson({ דּ: "bmp", "\u{1F602}": "astral" })
    expect(out.indexOf("astral")).toBeLessThan(out.indexOf("bmp"))
  })
})

describe("key ordering", () => {
  it("is byte-identical regardless of source property order", () => {
    const a = canonicalizeJson({ z: 1, m: 2, a: 3 })
    const b = canonicalizeJson({ a: 3, z: 1, m: 2 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":3,"m":2,"z":1}')
  })

  it("sorts digit-like keys lexically, not numerically", () => {
    // RFC 8785 §3.2.3 compares UTF-16 code units, so "1" < "10" < "2".
    expect(canonicalizeJson({ "10": 1, "2": 2, "1": 3 })).toBe('{"1":3,"10":1,"2":2}')
  })

  it("does not let integer-like keys be hoisted ahead of string keys", () => {
    // The regression this file exists for. Assembling the output through an
    // intermediate object silently loses the sort, because a JS object's own
    // property order puts array-index-like keys first in ascending NUMERIC
    // order no matter what order they were inserted in:
    //
    //   const o = {}; for (const k of ["1","10","2"]) o[k] = k
    //   JSON.stringify(o)  // {"1":..,"2":..,"10":..}  ← not insertion order
    //
    // So the serializer must build the string directly. Rust's BTreeMap has no
    // such rule, which is exactly how the two sides diverged.
    expect(canonicalizeJson({ b: 1, "10": 2, a: 3, "2": 4 })).toBe('{"10":2,"2":4,"a":3,"b":1}')
  })

  it("never reorders arrays", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]")
  })
})

describe("number normalization", () => {
  it("renders negative zero as 0", () => {
    expect(canonicalizeJson(-0)).toBe("0")
    expect(canonicalizeJson({ a: -0 })).toBe('{"a":0}')
  })

  it("uses ECMAScript exponential form at the documented thresholds", () => {
    expect(canonicalizeJson(1e21)).toBe("1e+21")
    expect(canonicalizeJson(1e-7)).toBe("1e-7")
    // Just inside the thresholds stays positional.
    expect(canonicalizeJson(1e20)).toBe("100000000000000000000")
    expect(canonicalizeJson(1e-6)).toBe("0.000001")
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite value %p",
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow(CanonicalJsonError)
    }
  )
})

describe("rejection rather than coercion", () => {
  it("rejects a lone high surrogate", () => {
    // The key cross-language trap: JSON.parse accepts this, serde_json does not.
    expect(() => canonicalizeJson({ s: "\ud800" })).toThrow(/unpaired high surrogate/)
  })

  it("rejects a lone low surrogate", () => {
    expect(() => canonicalizeJson({ s: "\udc00" })).toThrow(/unpaired low surrogate/)
  })

  it("accepts a well-formed surrogate pair", () => {
    expect(canonicalizeJson({ s: "😂" })).toBe('{"s":"😂"}')
  })

  it("rejects a lone surrogate in a KEY, not just a value", () => {
    expect(() => canonicalizeJson({ "\ud800": 1 })).toThrow(CanonicalJsonError)
  })

  it.each([
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a RegExp", /x/],
  ])("rejects %s so toJSON cannot rewrite signed content", (_label, value) => {
    expect(() => canonicalizeJson({ v: value })).toThrow(CanonicalJsonError)
  })

  it("rejects a class instance", () => {
    class Thing {
      a = 1
    }
    expect(() => canonicalizeJson(new Thing())).toThrow(/plain objects/)
  })

  it("accepts a plain object that crossed a realm boundary", () => {
    // `structuredClone`, worker `postMessage`, and Jest's own vm environment
    // all return objects whose prototype is a DIFFERENT realm's
    // `Object.prototype`. A strict `=== Object.prototype` check calls those
    // exotic and refuses to sign them, which would make a pack unsignable for
    // reasons having nothing to do with its content.
    const cloned = structuredClone({ b: 1, a: { c: [1, 2] } })
    expect(Object.getPrototypeOf(cloned)).not.toBe(Object.prototype)
    expect(canonicalizeJson(cloned)).toBe('{"a":{"c":[1,2]},"b":1}')
  })

  it("treats an own toJSON property as ordinary signed data", () => {
    // The serializer walks structure itself and hands only primitives to
    // `JSON.stringify`, so `toJSON` can never fire and rewrite what was signed.
    const sneaky = { toJSON: "not a function, just a key", z: 1 }
    expect(canonicalizeJson(sneaky)).toBe('{"toJSON":"not a function, just a key","z":1}')
  })

  it("rejects a circular reference instead of hanging", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => canonicalizeJson(cyclic)).toThrow(/circular/)
  })

  it("rejects BigInt", () => {
    expect(() => canonicalizeJson({ n: BigInt(1) })).toThrow(/BigInt/)
  })

  it("rejects undefined inside an array rather than silently emitting null", () => {
    // JSON.stringify turns [1, undefined] into [1,null], which would change
    // the signed content without anyone noticing.
    expect(() => canonicalizeJson([1, undefined])).toThrow(CanonicalJsonError)
    expect(() => canonicalizeJson([1, () => {}])).toThrow(CanonicalJsonError)
  })

  it("reports the path of the offending value", () => {
    try {
      canonicalizeJson({ characters: [{ ok: 1 }, { voiceProfile: { rate: Number.NaN } }] })
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError)
      expect((err as CanonicalJsonError).path).toBe("/characters/1/voiceProfile/rate")
    }
  })

  it("drops undefined object properties (matching the optional pack fields)", () => {
    expect(canonicalizeJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })
})

describe("canonicalPackString", () => {
  const pack = (): PluginCharacterPackDef =>
    ({
      id: "demo.pack",
      name: "Demo",
      version: "1.0.0",
      characters: [{ localId: "c1", name: "One", avatarColor: "#fff", systemPrompt: "p" }],
    }) as PluginCharacterPackDef

  it("excludes schemaVersion and signature even when present inline", () => {
    // The wrapper's fields are deliberately outside the signature, which is
    // what lets a v1 file be rewritten as v2 without invalidating it.
    const withWrapperFields = {
      ...pack(),
      schemaVersion: 2,
      signature: { algo: "ed25519", pubKey: "k", sig: "s" },
    } as unknown as PluginCharacterPackDef

    expect(canonicalPackString(withWrapperFields)).toBe(canonicalPackString(pack()))
    expect(canonicalPackString(withWrapperFields)).not.toContain("schemaVersion")
    expect(canonicalPackString(withWrapperFields)).not.toContain("signature")
  })

  it("is stable across property reordering of the same pack", () => {
    const a = canonicalPackString(pack())
    const reordered = {
      characters: pack().characters,
      version: "1.0.0",
      name: "Demo",
      id: "demo.pack",
    }
    expect(canonicalPackString(reordered as PluginCharacterPackDef)).toBe(a)
  })

  it("changes when any signed field changes", () => {
    const original = canonicalPackString(pack())
    const tampered = pack()
    tampered.characters[0].systemPrompt = "you are evil"
    expect(canonicalPackString(tampered)).not.toBe(original)
  })
})

describe("byte encoding", () => {
  it("encodes UTF-8, so multi-byte content measures larger than its length", () => {
    const bytes = canonicalJsonBytes({ s: "中" })
    expect(bytes).toBeInstanceOf(Uint8Array)
    // {"s":"中"} — 8 ASCII chars plus one 3-byte character = 11 bytes, but
    // only 9 UTF-16 units. Measuring `.length` would under-count every CJK pack.
    expect(bytes.length).toBe(11)
    expect(canonicalizeJson({ s: "中" }).length).toBe(9)
  })

  it("canonicalPackBytes matches canonicalPackString", () => {
    const p = {
      id: "a",
      name: "b",
      version: "1.0.0",
      characters: [],
    } as unknown as PluginCharacterPackDef
    expect(new TextDecoder().decode(canonicalPackBytes(p))).toBe(canonicalPackString(p))
  })
})

/**
 * The golden vectors above prove the two implementations agree on the cases
 * somebody thought to write down. This proves the artifact an author actually
 * ships verifies on the host.
 *
 * `__fixtures__/rust-signed-pack.json` was produced by the real
 * `cognia pack sign` binary and is checked in verbatim. Nothing here calls into
 * Rust: the bytes come from the TypeScript canonicalizer and the signature
 * check comes from Node's own Ed25519. If the two canonicalizers ever diverge
 * on numbers, escapes, or key order, this fails.
 *
 * The pack is deliberately adversarial — integer-like keys next to string keys
 * in a forward-compatible field, an astral key beside a BMP one, `1e-7` /
 * `1e+21` / `-0`, and DEL beside C0 controls in a display name.
 *
 * To regenerate after an intentional format change:
 *   cognia plugin keygen --out-dir .
 *   cognia pack sign <pack>.json --key plugin.private.b64
 */
describe("interop with the Rust signer", () => {
  /** Wrap a raw 32-byte Ed25519 key in the SPKI DER prefix Node requires. */
  function ed25519PublicKey(rawBase64: string) {
    return createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(rawBase64, "base64"),
      ]),
      format: "der",
      type: "spki",
    })
  }

  const pack = rustSignedPack.pack as unknown as PluginCharacterPackDef
  const { pubKey, sig } = rustSignedPack.signature

  function verifyPack(candidate: PluginCharacterPackDef): boolean {
    return verify(
      null,
      canonicalPackBytes(candidate),
      ed25519PublicKey(pubKey),
      Buffer.from(sig, "base64")
    )
  }

  it("agrees with the Rust signer on the canonical byte length", () => {
    // `cognia pack sign` reported signedBytes: 365 for this pack.
    expect(canonicalPackBytes(pack).length).toBe(365)
  })

  it("verifies a signature produced by the Rust CLI", () => {
    expect(verifyPack(pack)).toBe(true)
  })

  it("rejects the same pack once one signed field changes", () => {
    const tampered = structuredClone(pack)
    tampered.characters[0].systemPrompt = "you are compromised"
    expect(verifyPack(tampered)).toBe(false)
  })

  it("still verifies when the wrapper schemaVersion is rewritten", () => {
    // The v1 → v2 rewrite guarantee: `schemaVersion` lives outside the signed
    // bytes, so re-serializing the file at a newer schema keeps the signature.
    expect(rustSignedPack.schemaVersion).toBe(2)
    expect(verifyPack({ ...pack })).toBe(true)
  })
})
