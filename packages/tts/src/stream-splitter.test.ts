import { SentenceStreamSplitter, splitStream } from "./stream-splitter"

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c
}

describe("SentenceStreamSplitter", () => {
  it("cuts the first fragment on a wide separator once past the minimum length", () => {
    const s = new SentenceStreamSplitter()
    // "Sure thing," — comma is a first-fragment separator, and we're past 10 chars.
    expect(s.push("Sure thing, let me check")).toEqual(["Sure thing,"])
  })

  it("does not cut before the minimum first-fragment length", () => {
    const s = new SentenceStreamSplitter()
    // "Hi, " has a comma but is under 10 chars — hold.
    expect(s.push("Hi, ")).toEqual([])
    expect(s.push("everyone here.")).toEqual(["Hi, everyone here."])
  })

  it("switches to sentence enders (narrow set) after the first fragment", () => {
    const s = new SentenceStreamSplitter()
    // First fragment cuts on the comma…
    expect(s.push("First part, ")).toEqual(["First part,"])
    // …after which a comma no longer splits — only sentence enders do.
    expect(s.push("still going, and now done. Next")).toEqual(["still going, and now done."])
  })

  it("force-emits the first fragment after enough words without a separator", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterWords: 5 })
    // Five words, no separator → forced out so first audio isn't held up.
    expect(s.push("one two three four five")).toEqual(["one two three four five"])
  })

  it("force-emits the first fragment by characters for CJK (no spaces)", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterChars: 12 })
    // No spaces → word-count force can't fire; the char cap does.
    expect(s.push("这是一段没有标点的中文流式文本内容")).toHaveLength(1)
  })

  it("cuts on a Chinese full stop past the minimum length", () => {
    const s = new SentenceStreamSplitter()
    // 10 chars then 。 at index 9 → first fragment cut there; 再见 stays buffered.
    expect(s.push("你好呀今天天气不错。再见")).toEqual(["你好呀今天天气不错。"])
  })

  it("emits multiple fragments from a single push", () => {
    const s = new SentenceStreamSplitter({ minFirstFragmentLength: 1, minSentenceLength: 1 })
    expect(s.push("One. Two. Three.")).toEqual(["One.", "Two.", "Three."])
  })

  it("flush returns the buffered tail once, then nothing", () => {
    const s = new SentenceStreamSplitter()
    s.push("An incomplete tail with no ender")
    expect(s.flush()).toBe("An incomplete tail with no ender")
    expect(s.flush()).toBeNull()
  })

  it("flush returns null when nothing is buffered", () => {
    const s = new SentenceStreamSplitter()
    expect(s.flush()).toBeNull()
  })
})

describe("splitStream (pull wrapper)", () => {
  it("yields fragments in order across token boundaries and flushes the tail", async () => {
    const out: string[] = []
    for await (const frag of splitStream(
      fromChunks(["Hello there", ", I can help. ", "Second sentence here.", " Tail without ender"])
    )) {
      out.push(frag)
    }
    // First fragment grabbed early on the comma; then sentence enders; tail flushed.
    expect(out).toEqual([
      "Hello there,",
      "I can help.",
      "Second sentence here.",
      "Tail without ender",
    ])
  })

  it("emits nothing for an empty stream", async () => {
    const out: string[] = []
    for await (const frag of splitStream(fromChunks([]))) out.push(frag)
    expect(out).toEqual([])
  })
})
