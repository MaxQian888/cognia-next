"use client"

import { useInView, useReducedMotion } from "motion/react"
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react"

/**
 * One unit of a split headline: a word that rises into place, or the space
 * between two words (left as a real space, so lines still wrap there).
 */
export type SplitToken = { kind: "word"; text: string } | { kind: "space" }

/** Han, kana and Hangul: scripts that set without spaces and may break between any two characters. */
const CJK = /[⺀-⿿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿]/u
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
 * split that differs across the two is a hydration mismatch.
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
  const words = tokens.filter((token) => token.kind === "word").length
  const step = splitStagger(words)
  const lead = trigger === "mount" ? 0.05 : 0
  let wordIndex = 0

  const Tag = as
  return (
    <Tag ref={ref} className={className} data-split={phase} aria-label={text}>
      <span aria-hidden="true">
        {tokens.map((token, i) => {
          if (token.kind === "space") return <Fragment key={i}> </Fragment>
          const delayMs = Math.round((lead + wordIndex++ * step) * 1000)
          return (
            <span key={i} className="split-mask">
              <span data-split-word="" style={{ "--split-delay": `${delayMs}ms` } as CSSProperties}>
                {token.text}
              </span>
            </span>
          )
        })}
      </span>
    </Tag>
  )
}
