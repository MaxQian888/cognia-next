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

/** Identity, like the real helpers minus their validation. */
export function definePlugin<T>(definition: T): T {
  return definition
}

export function definePluginManifest<T>(manifest: T): T {
  return manifest
}
