/**
 * Test-only stub for `@cognia/plugin-sdk`.
 *
 * At runtime the host hands the real SDK to the plugin — `build` marks the
 * specifier `--external` and never bundles it, and the declarations under
 * `types/` exist purely so `tsc` can see the shape. Neither of those helps Jest,
 * which has to actually resolve and execute the module, so `jest.config.cjs`
 * maps the specifier here.
 *
 * Only the values the template imports at runtime live here. Types are erased by
 * ts-jest and need no counterpart. If your plugin starts importing another SDK
 * value, add it here too — the failure otherwise reads as a missing module
 * rather than a missing export.
 */

/**
 * The real `definePlugin` validates its argument and returns the definition the
 * host loader consumes. For tests, identity is the honest stub: it keeps the
 * shape the test asserts against without pretending to validate anything.
 */
export function definePlugin<T>(definition: T): T {
  return definition
}
