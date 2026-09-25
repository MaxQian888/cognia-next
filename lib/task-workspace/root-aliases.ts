/**
 * Carry root-keyed policy across a Registry Bundle turn.
 *
 * A bundle turn runs in aliases of the source checkouts, not in the checkouts
 * themselves. Anything that names roots by their source path, such as
 * confinement roots or the Workspace Trust proof (`trustedWorkspaceRoots`),
 * stops matching the send's active roots once cwd and additionalDirectories are
 * re-pointed at the aliases. The sidecar only honours a trusted root that is
 * also active for the send, so an un-remapped proof silently proves nothing.
 *
 * Pure leaf: no Tauri, no Dexie. Safe for the connector loop, the scheduler and
 * their tests without mocking.
 */

/**
 * Replace every value that is EXACTLY a source root with that root's alias.
 * A value with no mapping passes through unchanged. Matching is exact on the
 * trimmed path: a subdirectory of a source root is a different root, and the
 * trust grant it would inherit was never given for it.
 */
export function remapExactRoots(
  values: readonly string[],
  aliasesBySource: ReadonlyMap<string, string>
): string[] {
  return values.map((value) => aliasesBySource.get(value.trim()) ?? value)
}
