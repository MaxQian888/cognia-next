import {
  buildCaptureCommand,
  buildRunCommand,
  decodeBase64Utf8,
  extractCapture,
  findDone,
  stripMarkers,
} from "./pty-read"

describe("buildRunCommand", () => {
  it("appends a done marker carrying the exit code", () => {
    const cmd = buildRunCommand("strix -n --target 'x'", "tok1")
    expect(cmd).toContain("strix -n --target 'x'")
    expect(cmd).toContain(`@@SXD:tok1:%s@@`)
    expect(cmd).toContain(`"$?"`)
  })
})

describe("buildCaptureCommand", () => {
  it("frames the command between begin/end markers", () => {
    const cmd = buildCaptureCommand("base64 file", "tok2")
    expect(cmd.startsWith("printf '@@SXC:tok2@@'")).toBe(true)
    expect(cmd).toContain("{ base64 file; } 2>&1")
    expect(cmd).toContain(`@@SXE:tok2:%s@@`)
  })
})

describe("findDone", () => {
  it("returns the exit code once the done marker appears", () => {
    expect(findDone("noise\n@@SXD:t:0@@\n", "t")).toEqual({ exitCode: 0 })
    expect(findDone("@@SXD:t:2@@", "t")).toEqual({ exitCode: 2 })
    expect(findDone("@@SXD:t:130@@", "t")).toEqual({ exitCode: 130 })
  })

  it("returns null before completion", () => {
    expect(findDone("still running…", "t")).toBeNull()
  })

  it("ignores the echoed command template (%s, not a digit)", () => {
    // A PTY echoes the input, which contains the literal `%s` template.
    expect(findDone(`echo hi; printf '\\n@@SXD:t:%s@@\\n' "$?"`, "t")).toBeNull()
  })
})

describe("extractCapture", () => {
  it("returns the payload + exit code between markers", () => {
    expect(extractCapture("@@SXC:t@@PAYLOAD@@SXE:t:0@@\n", "t")).toEqual({
      raw: "PAYLOAD",
      exitCode: 0,
    })
  })

  it("uses the last begin marker so an echoed command can't pollute the capture", () => {
    const echoed = `printf '@@SXC:t@@'; { base64 f; } 2>&1; printf '@@SXE:t:%s@@'`
    const real = "@@SXC:t@@REALDATA@@SXE:t:0@@\n"
    expect(extractCapture(echoed + real, "t")).toEqual({ raw: "REALDATA", exitCode: 0 })
  })

  it("returns null before the end marker arrives", () => {
    expect(extractCapture("@@SXC:t@@partial", "t")).toBeNull()
  })
})

describe("stripMarkers", () => {
  it("removes all sentinel markers", () => {
    // The trailing newline after a marker is consumed; a leading one is kept.
    expect(stripMarkers("hi\n@@SXD:t:0@@\nbye")).toBe("hi\nbye")
    expect(stripMarkers("@@SXC:t@@x@@SXE:t:0@@")).toBe("x")
  })
})

describe("decodeBase64Utf8", () => {
  it("decodes base64 to a UTF-8 string", () => {
    const b64 = Buffer.from('{"a":1}', "utf-8").toString("base64")
    expect(decodeBase64Utf8(b64)).toBe('{"a":1}')
  })

  it("tolerates line-wrapped base64 (whitespace)", () => {
    const b64 = Buffer.from("hello world", "utf-8").toString("base64")
    const wrapped = `${b64.slice(0, 4)}\n${b64.slice(4)}\n`
    expect(decodeBase64Utf8(wrapped)).toBe("hello world")
  })

  it("decodes multibyte UTF-8", () => {
    const b64 = Buffer.from("漏洞 ✓", "utf-8").toString("base64")
    expect(decodeBase64Utf8(b64)).toBe("漏洞 ✓")
  })

  it("returns empty string for empty input", () => {
    expect(decodeBase64Utf8("")).toBe("")
    expect(decodeBase64Utf8("  \n ")).toBe("")
  })
})
