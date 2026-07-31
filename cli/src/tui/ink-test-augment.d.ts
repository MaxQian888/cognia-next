/**
 * Augments the `ink` module type with the test-only helpers exposed by the Jest
 * manual mock (`__mocks__/ink.js`). Lets the `.tsx` component tests import
 * `{ __fireInput, __resetInk } from "ink"` with types; these never exist in the
 * real `ink` and are never imported by production code.
 */
// `export {}` makes this file a module so the `declare module` below *augments*
// ink's real types (adding the mock-only helpers) instead of replacing them.
export {}

declare module "ink" {
  export function __fireInput(input: string, key?: Record<string, boolean>): void
  export function __resetInk(): void
}
