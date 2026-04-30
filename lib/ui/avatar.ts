// Avatar helpers shared by the guild rail, member list, message renderer, and
// character/team pickers. Characters and teams both expose the same shape:
// { name, avatarColor, avatarEmoji? }.

export interface AvatarSubject {
  name: string
  avatarColor?: string
  avatarEmoji?: string
}

/**
 * Pick a deterministic color when one isn't provided. Used by legacy sessions
 * (no associated character) so they still get a stable, distinguishable hue.
 */
export function deterministicColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `oklch(0.7 0.14 ${hue})`
}

/** Two-letter glyph used as the fallback when no emoji is set. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function avatarGlyph(subject: AvatarSubject): string {
  return subject.avatarEmoji ?? initials(subject.name)
}

export function avatarColor(subject: AvatarSubject): string {
  return subject.avatarColor ?? deterministicColor(subject.name)
}
