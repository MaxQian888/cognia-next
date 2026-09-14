/**
 * What counts as a selection worth acting on, and what to call it.
 *
 * Pure, so the transcript capsule, the mobile "select text" sheet and the chip a
 * selection becomes all agree on both questions.
 */

/**
 * Shortest deliberate selection in a script that spaces its words.
 *
 * Below this a selection is a mis-drag or a double-click on a stray word.
 */
export const MIN_SELECTION_CHARS = 3

/**
 * Shortest deliberate selection in a script that does not.
 *
 * One Han, Kana or Hangul character is a word or most of one, and the everyday
 * two-character words (变量, 関数, 함수) were exactly what the three-character
 * floor refused.
 */
export const MIN_DENSE_SCRIPT_SELECTION_CHARS = 2

/** Han, Hiragana, Katakana and Hangul syllables. */
const DENSE_SCRIPT = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u

/** Whether trimmed selected text is long enough to be deliberate. */
export function isDeliberateSelection(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length >= MIN_SELECTION_CHARS) return true
  return trimmed.length >= MIN_DENSE_SCRIPT_SELECTION_CHARS && DENSE_SCRIPT.test(trimmed)
}

/** Longest selection used verbatim as a name before it is elided. */
export const SELECTION_TITLE_MAX = 48

/**
 * Name something after the text it was made from, elided on a word boundary.
 *
 * Whitespace collapses first: a selection across paragraphs would otherwise
 * name an aside or a chip with a line break in it.
 */
export function selectionTitleFor(text: string, max = SELECTION_TITLE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** The selection as a Markdown block quote, ready to type a question under. */
export function quoteSelection(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}
