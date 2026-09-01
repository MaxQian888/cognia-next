/**
 * The id a new user-authored draft gets.
 *
 * Module-level rather than inline in a component for two reasons. It reads the
 * clock, which the React purity rule rightly refuses inside a component body,
 * and both the desktop Studio and the phone mint fork ids, which must not drift
 * into two different id shapes for the same act.
 *
 * The timestamp suffix is what keeps forking the same template twice from
 * colliding, since the slug alone is derived from a name the user may reuse.
 */

import type { TemplateDomain } from "./contracts"

export function makeTemplateDraftId(domain: TemplateDomain, name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // Collapse runs. The character class above allows `-`, so "A -- B" only
    // had its spaces replaced and came out as "a----b".
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  return `user.${domain}.${slug}.${Date.now().toString(36)}`
}
