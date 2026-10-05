/**
 * RFC 8785 (JSON Canonicalization Scheme): the encoding of everything this
 * protocol hashes or signs.
 *
 * A copy of `lib/plugin/character-pack/canonical-json.ts` (which explains the
 * leaf-versus-structure split), because this package is dependency-free and
 * is also bundled into the sync Worker. `jcs.test.ts` runs the same golden
 * vectors (`lib/plugin/character-pack/__fixtures__/jcs-vectors.json`), so the
 * two cannot drift.
 */

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
