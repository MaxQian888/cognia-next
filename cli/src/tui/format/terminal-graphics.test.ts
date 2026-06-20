import {
  buildImageEscape,
  detectGraphics,
  iterm2Escape,
  kittyEscape,
  kittyEscapeChunked,
} from "./terminal-graphics"

describe("terminal graphics", () => {
  describe("detectGraphics", () => {
    it("detects iTerm2 from TERM_PROGRAM", () => {
      expect(detectGraphics({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2")
    })

    it("detects WezTerm (iTerm2-compatible) from TERM_PROGRAM", () => {
      expect(detectGraphics({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2")
    })

    it("detects kitty from TERM", () => {
      expect(detectGraphics({ TERM: "xterm-kitty" })).toBe("kitty")
    })

    it("detects kitty from KITTY_WINDOW_ID env", () => {
      expect(detectGraphics({ KITTY_WINDOW_ID: "1" })).toBe("kitty")
    })

    it("returns none for a plain terminal", () => {
      expect(detectGraphics({ TERM: "xterm-256color" })).toBe("none")
    })

    it("returns none for an empty environment", () => {
      expect(detectGraphics({})).toBe("none")
    })

    it("prefers kitty over iterm2 when both signals present", () => {
      expect(detectGraphics({ TERM: "xterm-kitty", TERM_PROGRAM: "iTerm.app" })).toBe("kitty")
    })

    it("is case-insensitive for TERM_PROGRAM matching", () => {
      expect(detectGraphics({ TERM_PROGRAM: "iterm.app" })).toBe("iterm2")
    })
  })

  describe("iterm2Escape", () => {
    it("builds an iTerm2 inline-image escape", () => {
      const esc = iterm2Escape(Buffer.from("PNG"), "x.png")
      expect(esc.startsWith("\x1b]1337;File=")).toBe(true)
      expect(esc.endsWith("\x07")).toBe(true)
    })

    it("base64-encodes the name and embeds the byte size", () => {
      const data = Buffer.from("PNG")
      const esc = iterm2Escape(data, "x.png")
      const expectedName = Buffer.from("x.png").toString("base64")
      expect(esc).toContain(`name=${expectedName}`)
      expect(esc).toContain(`size=${data.length}`)
      expect(esc).toContain("inline=1")
    })

    it("embeds the base64 payload after the colon", () => {
      const data = Buffer.from("PNG")
      const esc = iterm2Escape(data, "x.png")
      const payload = data.toString("base64")
      expect(esc).toContain(`:${payload}`)
    })

    it("includes width and height when provided", () => {
      const esc = iterm2Escape(Buffer.from("PNG"), "x.png", {
        width: "40",
        height: "20",
      })
      expect(esc).toContain("width=40")
      expect(esc).toContain("height=20")
    })

    it("omits width and height when not provided", () => {
      const esc = iterm2Escape(Buffer.from("PNG"), "x.png")
      expect(esc).not.toContain("width=")
      expect(esc).not.toContain("height=")
    })
  })

  describe("kittyEscape", () => {
    it("produces a kitty graphics APC sequence", () => {
      const esc = kittyEscape(Buffer.from("PNG"), "x.png")
      expect(esc.startsWith("\x1b_G")).toBe(true)
      expect(esc.endsWith("\x1b\\")).toBe(true)
    })

    it("uses a=T (transmit and display) and f=100 (PNG)", () => {
      const esc = kittyEscape(Buffer.from("PNG"), "x.png")
      expect(esc).toContain("a=T")
      expect(esc).toContain("f=100")
    })

    it("embeds the base64 payload after the control separator", () => {
      const data = Buffer.from("PNG")
      const esc = kittyEscape(data, "x.png")
      const payload = data.toString("base64")
      expect(esc).toContain(`;${payload}`)
    })
  })

  describe("kittyEscapeChunked", () => {
    it("emits a single m=0 chunk for a small image", () => {
      const esc = kittyEscapeChunked(Buffer.from("PNG"))
      expect(esc.startsWith("\x1b_Ga=T,f=100,m=0;")).toBe(true)
      expect((esc.match(/\x1b_G/g) ?? []).length).toBe(1)
    })

    it("splits a large image across APC chunks with m=1 then a final m=0", () => {
      // > 4096 base64 chars: 4096 raw bytes encodes to ~5462 base64 chars.
      const big = Buffer.alloc(4096, 1)
      const esc = kittyEscapeChunked(big)
      const chunks = esc.split("\x1b\\").filter(Boolean)
      expect(chunks.length).toBeGreaterThan(1)
      // First chunk carries the full control set.
      expect(chunks[0].startsWith("\x1b_Ga=T,f=100,m=1;")).toBe(true)
      // A continuation carries only the m= control.
      expect(chunks[1].startsWith("\x1b_Gm=")).toBe(true)
      // The last chunk closes the transmission with m=0.
      expect(chunks[chunks.length - 1]).toContain("m=0;")
    })
  })

  describe("buildImageEscape", () => {
    it("dispatches by protocol and returns null for none", () => {
      const data = Buffer.from("PNG")
      expect(buildImageEscape("iterm2", data, "x")?.startsWith("\x1b]1337;")).toBe(true)
      expect(buildImageEscape("kitty", data, "x")?.startsWith("\x1b_G")).toBe(true)
      expect(buildImageEscape("none", data, "x")).toBeNull()
    })
  })
})
