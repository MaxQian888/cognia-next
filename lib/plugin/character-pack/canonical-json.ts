/**
 * RFC 8785 (JSON Canonicalization Scheme) for Character Pack signatures.
 *
 * A signature is only meaningful if both sides agree, byte for byte, on what
 * was signed. The signed bytes for a `.cognia-pack.json` are the canonical JSON
 * of the **`pack` object only** — the outer `schemaVersion` and `signature` are
 * excluded, which is what lets a v1 file be re-written as v2 without
 * invalidating its signature.
 *
 * # Why this leans on `JSON.stringify` — but only for leaves
 *
 * RFC 8785 defines number formatting *as* ECMAScript `Number::toString` and
 * string escaping as ES2019 well-formed `JSON.stringify`. JavaScript already
 * implements both correctly, so every *leaf* below is emitted by handing it
 * straight to `JSON.stringify`. Reimplementing that would be pure risk.
 *
 * Structure — braces, commas, and above all key order — is assembled here
 * instead, because `JSON.stringify` cannot be trusted with it:
 *
 * ```js
 * const o = {}
 * for (const k of ["1", "10", "2"]) o[k] = k
 * JSON.stringify(o) // {"1":"1","2":"2","10":"10"}  ← NOT insertion order
 * ```
 *
 * Integer-like keys are hoisted to the front in ascending *numeric* order by
 * the object's own property-order rules (ECMAScript `OrdinaryOwnPropertyKeys`),
 * which silently undoes any sort applied beforehand. RFC 8785 §3.2.3 wants
 * `"1" < "10" < "2"`. Building the string directly is the only way to keep the
 * sort, so no intermediate object is ever constructed.
 *
 * The Rust twin (`crates/cognia-cli/src/engine/canonical_json.rs`) has to
 * reimplement the leaf formatting as well. That asymmetry is deliberate: the
 * reimplementation lives on the *signing* path, where `cognia pack sign`
 * self-verifies before writing, so a formatter bug fails loudly at authoring
 * time instead of silently at verification time. The shared golden fixture in
 * `__fixtures__/jcs-vectors.json` drives both suites — it is what caught the
 * integer-key bug described above.
 */

import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

export class CanonicalJsonError extends Error {
  /** JSON-pointer-ish location, e.g. `/characters/2/voiceProfile/rate`. */
  readonly path: string

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "/"})`)
    this.name = "CanonicalJsonError"
    this.path = path || "/"
  }
}

/**
 * Reject strings containing an unpaired surrogate.
 *
 * The single most important cross-language rule here. `JSON.parse('"\\ud800"')`
 * succeeds in JavaScript and yields a lone surrogate; Rust's `serde_json`
 * rejects the same input. Without symmetric rejection, a pack would be
 * verifiable on the host but unsignable by the CLI — which surfaces to an
 * author as "signature randomly fails on packs with emoji".
 */
function assertWellFormed(value: string, path: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    // High surrogate must be followed by a low surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError("string contains an unpaired high surrogate", path)
      }
      i++
      continue
    }
    // A low surrogate here was not preceded by a high one.
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError("string contains an unpaired low surrogate", path)
    }
  }
}

/**
 * True for `{}`-shaped values, false for `Date` / `Map` / `Set` / `RegExp` /
 * class instances — which would otherwise serialize as `{}` and quietly change
 * what a signature covers.
 *
 * The third clause is what makes this realm-safe. `structuredClone`, a worker
 * `postMessage`, and Jest's vm-based environments all hand back plain objects
 * whose prototype is a *different realm's* `Object.prototype`, so identity
 * against this realm's fails on a value that is a plain object by every
 * meaningful definition. A prototype whose own prototype is `null` is an
 * `Object.prototype` — some realm's — while a class instance's prototype chain
 * always has `Object.prototype` above it and so does not match.
 *
 * Note that `toJSON` is not a concern here: the serializer walks structure
 * itself and only ever hands primitives to `JSON.stringify`, so a `toJSON`
 * property is treated as ordinary data and can never rewrite signed content.
 */
function isPlainObject(value: object): boolean {
  const proto: object | null = Object.getPrototypeOf(value)
  if (proto === null || proto === Object.prototype) return true
  return Object.getPrototypeOf(proto) === null
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null"

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number: ${String(value)}`, path)
      }
      // RFC 8785 §3.2.2.3 defines number formatting as ECMAScript
      // `Number::toString`, which is exactly what `JSON.stringify` applies.
      // Negative zero normalizes to "0" — `Object.is` is the only way to spot
      // it, since `-0 === 0`.
      return JSON.stringify(Object.is(value, -0) ? 0 : value) as string
    case "string":
      assertWellFormed(value, path)
      // ES2019 well-formed escaping: short escapes, lowercase \u00xx for the
      // remaining C0 controls, everything else literal.
      return JSON.stringify(value)
    case "bigint":
      throw new CanonicalJsonError("BigInt cannot be canonicalized", path)
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalJsonError(`${typeof value} cannot be canonicalized`, path)
  }

  const obj = value as object
  if (seen.has(obj)) {
    throw new CanonicalJsonError("circular reference", path)
  }

  if (Array.isArray(obj)) {
    seen.add(obj)
    // Array order is preserved — it is semantic, and RFC 8785 never reorders.
    const parts = obj.map((item, index) => {
      if (item === undefined) {
        // `JSON.stringify` would silently emit `null` here, changing the signed
        // content. Refuse instead of quietly rewriting it.
        throw new CanonicalJsonError("array holes / undefined entries", `${path}/${index}`)
      }
      return serialize(item, `${path}/${index}`, seen)
    })
    seen.delete(obj)
    return `[${parts.join(",")}]`
  }

  if (!isPlainObject(obj)) {
    // Date, Map, Set, RegExp, class instances. Each has a `toJSON` or a lossy
    // default that would let the *serialized* content differ from the object
    // that was reviewed and registered.
    throw new CanonicalJsonError(
      `only plain objects can be canonicalized, got ${obj.constructor?.name ?? "an exotic object"}`,
      path
    )
  }

  seen.add(obj)
  const source = obj as Record<string, unknown>
  // RFC 8785 §3.2.3 sorts by UTF-16 code unit. Bare `Array.prototype.sort()`
  // does exactly that. NEVER `localeCompare` — it collates, which reorders
  // non-ASCII keys and produces bytes the Rust side will not reproduce.
  const keys = Object.keys(source).sort()
  const parts: string[] = []
  for (const key of keys) {
    const child = source[key]
    // Matches `JSON.stringify` and the `?:` optionals on the pack types: an
    // absent key and an explicitly-undefined key sign identically.
    if (child === undefined) continue
    assertWellFormed(key, path)
    // Emitted in sorted order because we are writing the string ourselves. An
    // intermediate object would hoist integer-like keys and silently lose it.
    parts.push(`${JSON.stringify(key)}:${serialize(child, `${path}/${key}`, seen)}`)
  }
  seen.delete(obj)
  return `{${parts.join(",")}}`
}

/** RFC 8785 canonical JSON. Throws {@link CanonicalJsonError} on any non-JSON value. */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, "", new Set())
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value))
}

/**
 * The exact bytes a Character Pack signature covers.
 *
 * Only the `pack` object. `schemaVersion` and `signature` live on the wrapper
 * and are deliberately outside the signature, so bumping the file schema never
 * invalidates a valid signature. Defensively strips both keys in case a
 * malformed pack carries them inline.
 */
export function canonicalPackString(pack: PluginCharacterPackDef): string {
  const {
    schemaVersion: _schemaVersion,
    signature: _signature,
    ...rest
  } = pack as PluginCharacterPackDef & { schemaVersion?: unknown; signature?: unknown }
  void _schemaVersion
  void _signature
  return canonicalizeJson(rest)
}

export function canonicalPackBytes(pack: PluginCharacterPackDef): Uint8Array {
  return new TextEncoder().encode(canonicalPackString(pack))
}
