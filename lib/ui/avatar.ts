// Avatar helpers shared by the guild rail, member list, message renderer, and
// character/team pickers. Characters and teams both expose the same shape:
// { name, avatarColor, avatarEmoji? }.

export interface AvatarSubject {
  name: string
  avatarColor?: string
  avatarEmoji?: string
  /**
   * Optional resolved avatar image URL (a `data:` URL or `convertFileSrc`
   * result). When present, renderers show the image and fall back to
   * `avatarEmoji` / initials only if it fails to load.
   */
  avatarImageUrl?: string
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

/**
 * Two-letter glyph used as the fallback when no emoji is set.
 *
 * Built from the words a person reads as the name. A glyph is two characters,
 * so every one of them has to carry the name: it used to take the first
 * character of the first and last word whatever they were, which turned a
 * conversation titled "Document mobile tab bar #399" into "D#" and "(draft)
 * plan" into "(P". So:
 *
 *  - words with a letter in them are the name; digit-only words ("#399",
 *    "2026") are the fallback when there is nothing else, and a word of pure
 *    punctuation or emoji never contributes;
 *  - within a word, only letters and digits count, so "(draft)" reads as "d";
 *  - characters are taken by code point, so a letter outside the BMP is never
 *    split in half.
 *
 * A name with no letter or digit at all keeps its first two characters, which
 * is what an emoji-only name should show.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const alnum = (word: string) => Array.from(word).filter((ch) => /[\p{L}\p{N}]/u.test(ch))
  const lettered = words.filter((word) => /\p{L}/u.test(word))
  const pool = lettered.length > 0 ? lettered : words.filter((word) => /\p{N}/u.test(word))
  if (pool.length === 0) return Array.from(words[0]).slice(0, 2).join("").toUpperCase()
  if (pool.length === 1) return alnum(pool[0]).slice(0, 2).join("").toUpperCase()
  return (alnum(pool[0])[0] + alnum(pool[pool.length - 1])[0]).toUpperCase()
}

export function avatarGlyph(subject: AvatarSubject): string {
  return subject.avatarEmoji ?? initials(subject.name)
}

export function avatarColor(subject: AvatarSubject): string {
  return subject.avatarColor ?? deterministicColor(subject.name)
}
