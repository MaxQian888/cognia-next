/**
 * The canonical `publisher.name` identifier rule for VS Code extensions.
 *
 * This is the TypeScript twin of `sanitize_plugin_id_strict` in
 * `crates/cognia-plugin-runtime/src/lib.rs`. Both sides derive the id from the
 * same untrusted `package.json` fields, and the id becomes both a Dexie
 * primary key and a filesystem directory name — so if the two rules drift, the
 * database row and the on-disk directory silently stop referring to the same
 * extension. Keep them in lockstep.
 *
 * The rule keeps the long-standing "escape, don't reject" behaviour for merely
 * unusual characters (`publisher@with@symbols` -> `publisher-with-symbols`),
 * and changes exactly one thing: **`.` is escaped too, instead of preserved.**
 *
 * That one change is what closes the hole. The previous rule was
 * `s.replace(/[^A-Za-z0-9._-]/g, "-")` — note the `.` in the allowed set. So
 * `publisher: ""` + `name: "."` passed through untouched and composed into the
 * id `".."`, a traversing path component handed to the installer, which joined
 * it onto the extension root and recursively deleted the result.
 *
 * With `.` escaped and empty components rejected, the composition is safe *by
 * construction* rather than by filtering: no component can contain `.`, `/`,
 * or `\`, and none can be empty, so `${publisher}.${name}` can never be `"."`,
 * `".."`, or anything other than a single path component.
 */

/** Maximum length of a single id component (`publisher` or `name`). */
export const MAX_ID_COMPONENT_LENGTH = 64

/**
 * Characters kept verbatim in an id component. Everything else — crucially
 * including `.` — is escaped to `-`.
 */
const ID_COMPONENT_DISALLOWED = /[^A-Za-z0-9_-]/g

/** Thrown when a manifest's `publisher` / `name` cannot form a safe id. */
export class InvalidExtensionIdError extends Error {
  constructor(
    readonly component: "publisher" | "name",
    readonly value: unknown,
    reason: string
  ) {
    super(`VS Code extension "${component}" ${reason}: ${JSON.stringify(value)}`)
    this.name = "InvalidExtensionIdError"
  }
}

/**
 * Escape a single id component into a safe path segment.
 *
 * @throws {InvalidExtensionIdError} when the value is not a string, is empty,
 * or is too long. Emptiness has to be an error rather than an escape: escaping
 * `""` yields `""`, and `""` + `""` composes into `"."`.
 */
export function safeIdComponent(component: "publisher" | "name", value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidExtensionIdError(component, value, "must be a string")
  }
  if (value.length === 0) {
    // `""` used to pass every check on both sides: it *is* a string, and
    // escaping it is a no-op.
    throw new InvalidExtensionIdError(component, value, "must not be empty")
  }
  if (value.length > MAX_ID_COMPONENT_LENGTH) {
    throw new InvalidExtensionIdError(
      component,
      value,
      `must be at most ${MAX_ID_COMPONENT_LENGTH} characters`
    )
  }
  return value.replace(ID_COMPONENT_DISALLOWED, "-")
}

/**
 * Compose the canonical `publisher.name` id.
 *
 * The single `.` between the two escaped components is the only dot the result
 * can contain, which is what makes `"."` and `".."` unreachable.
 *
 * @throws {InvalidExtensionIdError} when either component is unusable.
 */
export function canonicalExtensionId(publisher: unknown, name: unknown): string {
  return `${safeIdComponent("publisher", publisher)}.${safeIdComponent("name", name)}`
}
