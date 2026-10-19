"use client"

import { useInView, useReducedMotion } from "motion/react"
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import cjkWords from "@web/content/generated/cjk-words.json"
import { CJK, normalizeTitle } from "@web/lib/cjk-words"

/**
 * One unit of a split headline: a word that rises into place, or the space
 * between two words (left as a real space, so lines still wrap there).
 */
export type SplitToken = { kind: "word"; text: string } | { kind: "space" }

/** Punctuation that must not begin a line: it stays with the character before it. */
const CLOSING = /[。，、．！？：；）」』》〉】〕”’…·,.!?:;)\]}%]/u
/** Punctuation that must not end a line: it travels with the character after it. */
const OPENING = /[（「『《〈【〔“‘([{]/u

/**
 * Split a headline into the units that rise in turn.
 *
 * Latin text splits on whitespace, one unit per word. CJK text splits per
 * character, because that is where it can break and the character is the unit
 * a reader's eye takes in. Closing punctuation is appended to the unit before
 * it and opening punctuation prepended to the unit after, so the split never
 * lets `。` start a line or `「` end one — the same rule the browser applies to
 * unsplit text.
 *
 * Deterministic on purpose: `Intl.Segmenter` would give better CJK words but
 * its dictionaries differ between the server's ICU and the browser's, and a
 * split that differs across the two is a hydration mismatch. Words still
 * decide where a line may break, through `cjkGlue` and the boundaries the build
 * segmented once.
 */
export function splitWords(text: string): SplitToken[] {
  const tokens: SplitToken[] = []
  let word = ""
  let pendingOpen = ""

  const flush = () => {
    if (word) tokens.push({ kind: "word", text: word })
    word = ""
  }
  const lastWord = (): { kind: "word"; text: string } | undefined => {
    const last = tokens[tokens.length - 1]
    return last?.kind === "word" ? last : undefined
  }

  for (const char of text) {
    if (/\s/u.test(char)) {
      flush()
      if (pendingOpen) {
        tokens.push({ kind: "word", text: pendingOpen })
        pendingOpen = ""
      }
      if (tokens.length > 0 && tokens[tokens.length - 1].kind !== "space") {
        tokens.push({ kind: "space" })
      }
      continue
    }
    if (OPENING.test(char)) {
      flush()
      pendingOpen += char
      continue
    }
    if (CLOSING.test(char)) {
      if (word) {
        word += char
        continue
      }
      const previous = lastWord()
      if (previous && !pendingOpen) {
        previous.text += char
        continue
      }
      word = pendingOpen + char
      pendingOpen = ""
      continue
    }
    if (CJK.test(char)) {
      flush()
      tokens.push({ kind: "word", text: pendingOpen + char })
      pendingOpen = ""
      continue
    }
    word += pendingOpen + char
    pendingOpen = ""
  }
  flush()
  if (pendingOpen) tokens.push({ kind: "word", text: pendingOpen })
  if (tokens[tokens.length - 1]?.kind === "space") tokens.pop()
  return tokens
}

/** Word starts for each Chinese copy title, from Node's ICU at build time. */
const CJK_WORDS: Readonly<Record<string, readonly number[]>> = cjkWords

/**
 * Which units must stay on one line with the unit after them: `glue[i]` is
 * true when unit `i` and unit `i + 1` are two characters of one CJK word.
 *
 * Per-character units let a line break anywhere, so a Chinese headline could
 * end a line on 任 and start the next on 何. `starts` are the word starts of
 * the normalised text (`lib/cjk-words.ts`); a seam between two adjacent units
 * that is not a word start is glued. Units with a space between them are never
 * glued (the space is a break the copy chose), and neither is anything outside
 * CJK. Without `starts` — a title the build has not segmented — nothing is.
 */
export function cjkGlue(tokens: SplitToken[], starts: readonly number[] | undefined): boolean[] {
  const glue = tokens.map(() => false)
  if (!starts) return glue
  const boundaries = new Set(starts)
  let offset = 0
  for (let i = 0; i < tokens.length - 1; i++) {
    const current = tokens[i]
    const next = tokens[i + 1]
    offset += current.kind === "word" ? current.text.length : 1
    if (current.kind !== "word" || next.kind !== "word") continue
    if (!CJK.test(current.text) || !CJK.test(next.text)) continue
    glue[i] = !boundaries.has(offset)
  }
  return glue
}

/**
 * The delay between two units, in seconds. A long headline's cascade is
 * divided down so the last unit lands within the same budget as a short one's
 * — a Chinese title is fifteen units where its English one is six.
 */
export function splitStagger(count: number): number {
  if (count < 2) return 0
  return Math.min(0.045, 0.36 / (count - 1))
}

type Phase = "static" | "armed" | "run"

interface SplitRevealProps {
  text: string
  as?: "h1" | "h2"
  className?: string
  /**
   * `mount` rises on first paint and is for the first screen; it runs from CSS
   * alone, so it never waits on hydration. `view` rises when the heading
   * scrolls in — and only if it was off screen when the page hydrated.
   */
  trigger?: "mount" | "view"
}

/**
 * **Headline reveal** — a heading whose words rise into place behind a mask,
 * one after another (DESIGN.md, Motion).
 *
 * Three rules keep it honest:
 *
 *  - The text is never hidden before hydration. `mount` is a CSS animation that
 *    starts with the first paint, JavaScript or not. `view` renders its words
 *    in place on the server and only *arms* (hides) a heading after mount if it
 *    is still off screen, so nothing the reader can see ever disappears.
 *  - Reduced motion shows the finished heading. `view` never arms; `mount`'s
 *    keyframes are cancelled by the stylesheet's reduced-motion belt. The
 *    mount path deliberately does not branch on the hook: the server cannot
 *    know the preference, and a client that rendered differently would be a
 *    hydration mismatch.
 *  - The heading has one accessible name, the plain title, from `aria-label`;
 *    the split copy is hidden from assistive technology, which would otherwise
 *    announce each masked unit on its own. The split copy is still the heading's
 *    only text — real spaces between words — so search snippets, reader modes
 *    and copy-paste read the title exactly once.
 *  - A CJK headline breaks between words, not inside one. Each word's
 *    characters share a `nowrap` group, from boundaries segmented at build
 *    time (`lib/cjk-words.ts`), so server and browser render the same markup.
 */
export function SplitReveal({ text, as = "h2", className, trigger = "view" }: SplitRevealProps) {
  const ref = useRef<HTMLHeadingElement>(null)
  const reduced = useReducedMotion() ?? false
  const inView = useInView(ref, { once: true, amount: 0.4 })
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (trigger !== "view" || reduced) return
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const onScreen = rect.bottom > 0 && rect.top < window.innerHeight
    // A heading already on screen is being read: leave it where it is.
    if (!onScreen) setArmed(true)
  }, [trigger, reduced])

  const phase: Phase = trigger === "mount" ? "run" : armed ? (inView ? "run" : "armed") : "static"

  const tokens = splitWords(text)
  const glue = cjkGlue(tokens, CJK_WORDS[normalizeTitle(text)])
  const words = tokens.filter((token) => token.kind === "word").length
  const step = splitStagger(words)
  const lead = trigger === "mount" ? 0.05 : 0
  let wordIndex = 0

  const unit = (text: string, key: number) => {
    const delayMs = Math.round((lead + wordIndex++ * step) * 1000)
    return (
      <span key={key} className="split-mask">
        <span data-split-word="" style={{ "--split-delay": `${delayMs}ms` } as CSSProperties}>
          {text}
        </span>
      </span>
    )
  }

  // A CJK word's characters share a `nowrap` group, the only thing that keeps
  // two inline-block masks on one line.
  const nodes: ReactNode[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === "space") {
      nodes.push(<Fragment key={i}> </Fragment>)
      continue
    }
    if (!glue[i]) {
      nodes.push(unit(token.text, i))
      continue
    }
    const first = i
    const group: ReactNode[] = []
    while (glue[i]) {
      group.push(unit((tokens[i] as { text: string }).text, i))
      i++
    }
    group.push(unit((tokens[i] as { text: string }).text, i))
    nodes.push(
      <span key={`w${first}`} data-split-group="" className="whitespace-nowrap">
        {group}
      </span>
    )
  }

  const Tag = as
  return (
    <Tag ref={ref} className={className} data-split={phase} aria-label={text}>
      <span aria-hidden="true">{nodes}</span>
    </Tag>
  )
}
