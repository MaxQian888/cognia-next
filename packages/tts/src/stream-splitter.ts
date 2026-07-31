/**
 * Incremental sentence splitter for streaming TTS (plan W7 / D3).
 *
 * The old pipeline synthesized only after the whole reply was generated, so
 * first-audio latency = "LLM fully done + whole text synthesized". This splitter
 * turns a growing text stream into speakable fragments *as tokens arrive*, so
 * synthesis of fragment 1 can start while the model is still writing fragment 2.
 *
 * Two-tier boundary policy (inspired by stream2sentence):
 *  - The FIRST fragment uses a WIDE separator set and a small minimum length so
 *    audio starts as soon as possible; if no separator shows up it is force-cut
 *    after enough words/characters rather than waiting.
 *  - Every fragment after that uses a NARROW separator set (sentence enders) and
 *    a minimum length, trading a little latency for natural prosody.
 *
 * Consumer-agnostic: `push()`/`flush()` suit a push source (per-delta callback);
 * `splitStream()` wraps them for a pull source (async iterable of tokens).
 */

export interface StreamSplitterOptions {
  /** Wide set used only for the first fragment (grab first audio fast). */
  firstFragmentSeparators?: string
  /** Minimum characters before the first fragment may be cut. */
  minFirstFragmentLength?: number
  /** Force-emit the first fragment after this many words even without a separator. */
  forceFirstFragmentAfterWords?: number
  /** Force-emit the first fragment after this many characters (covers CJK, which has no spaces). */
  forceFirstFragmentAfterChars?: number
  /** Narrow set (sentence enders) used for every fragment after the first. */
  sentenceSeparators?: string
  /** Minimum characters before a subsequent fragment may be cut. */
  minSentenceLength?: number
}

const DEFAULTS: Required<StreamSplitterOptions> = {
  // Note: the plan lists a bare "-" in the first set; it is intentionally
  // omitted here because it splits hyphenated words mid-token for no real gain.
  firstFragmentSeparators: ".?!;:,\n…)]}。！？；：，",
  minFirstFragmentLength: 10,
  forceFirstFragmentAfterWords: 30,
  forceFirstFragmentAfterChars: 60,
  sentenceSeparators: ".?!\n…。！？",
  minSentenceLength: 10,
}

export class SentenceStreamSplitter {
  private buffer = ""
  private isFirst = true
  private readonly opts: Required<StreamSplitterOptions>

  constructor(options: StreamSplitterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  /** Feed more text; return any fragments that completed (possibly none). */
  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    for (;;) {
      const cut = this.findCut()
      if (cut < 0) break
      const fragment = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (fragment) {
        out.push(fragment)
        this.isFirst = false
      }
    }
    return out
  }

  /** Emit whatever remains buffered as a final fragment (or null if empty). */
  flush(): string | null {
    const tail = this.buffer.trim()
    this.buffer = ""
    if (!tail) return null
    this.isFirst = false
    return tail
  }

  private findCut(): number {
    const seps = this.isFirst ? this.opts.firstFragmentSeparators : this.opts.sentenceSeparators
    const minLen = this.isFirst ? this.opts.minFirstFragmentLength : this.opts.minSentenceLength
    const b = this.buffer
    for (let i = Math.max(0, minLen - 1); i < b.length; i++) {
      if (seps.includes(b[i])) return i + 1
    }
    if (this.isFirst) {
      const words = b.trim().split(/\s+/).filter(Boolean).length
      if (words >= this.opts.forceFirstFragmentAfterWords) return b.length
      if (b.length >= this.opts.forceFirstFragmentAfterChars) return b.length
    }
    return -1
  }
}

/**
 * Pull-style wrapper: drive the splitter from an async iterable of text tokens,
 * yielding speakable fragments in order (including the flushed tail).
 */
export async function* splitStream(
  tokens: AsyncIterable<string>,
  options: StreamSplitterOptions = {}
): AsyncGenerator<string> {
  const splitter = new SentenceStreamSplitter(options)
  for await (const token of tokens) {
    for (const fragment of splitter.push(token)) yield fragment
  }
  const tail = splitter.flush()
  if (tail) yield tail
}
