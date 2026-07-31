import {
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_OPEN,
  hasAgentBlock,
  stripAgentBlocks,
  wrapAgentBlock,
} from "@/lib/agent-team/agent-blocks"

describe("wrapAgentBlock", () => {
  it("wraps trimmed text in the tag", () => {
    expect(wrapAgentBlock("  do X first  ")).toBe(
      `${AGENT_BLOCK_OPEN}\ndo X first\n${AGENT_BLOCK_CLOSE}`
    )
  })

  it("returns empty string for empty/whitespace/non-string input", () => {
    expect(wrapAgentBlock("")).toBe("")
    expect(wrapAgentBlock("   \n ")).toBe("")
    expect(wrapAgentBlock(undefined as unknown as string)).toBe("")
  })
})

describe("hasAgentBlock", () => {
  it("detects a block anywhere in the text", () => {
    expect(hasAgentBlock(`hi ${AGENT_BLOCK_OPEN}secret${AGENT_BLOCK_CLOSE} bye`)).toBe(true)
  })

  it("is false when no block and for non-strings", () => {
    expect(hasAgentBlock("just normal text")).toBe(false)
    expect(hasAgentBlock(123 as unknown as string)).toBe(false)
  })

  it("is repeatable (resets regex lastIndex)", () => {
    const s = `${AGENT_BLOCK_OPEN}x${AGENT_BLOCK_CLOSE}`
    expect(hasAgentBlock(s)).toBe(true)
    expect(hasAgentBlock(s)).toBe(true)
  })
})

describe("stripAgentBlocks", () => {
  it("removes the block and trims surrounding whitespace", () => {
    const text = `Done — deploy is green.\n\n${AGENT_BLOCK_OPEN}\nremember to bump the cache key\n${AGENT_BLOCK_CLOSE}`
    expect(stripAgentBlocks(text)).toBe("Done — deploy is green.")
  })

  it("removes multiple blocks and collapses blank runs", () => {
    const text = `a ${AGENT_BLOCK_OPEN}h1${AGENT_BLOCK_CLOSE}\n\n\nb ${AGENT_BLOCK_OPEN}h2${AGENT_BLOCK_CLOSE}`
    expect(stripAgentBlocks(text)).toBe("a \n\nb")
  })

  it("returns the original (trimmed) text when there is no block", () => {
    expect(stripAgentBlocks("  plain text  ")).toBe("plain text")
  })

  it("returns empty string for non-string input", () => {
    expect(stripAgentBlocks(null as unknown as string)).toBe("")
  })

  it("handles multiline block bodies", () => {
    const text = `Visible.\n${AGENT_BLOCK_OPEN}\nline 1\nline 2\n${AGENT_BLOCK_CLOSE}\nAlso visible.`
    expect(stripAgentBlocks(text)).toBe("Visible.\n\nAlso visible.")
  })
})
