/**
 * @jest-environment node
 */

import { pythonTracebackParser } from "./python-traceback-parser"

describe("pythonTracebackParser", () => {
  it("parses a multi-frame traceback into a stack node + exception text", () => {
    const text = `Traceback (most recent call last):
  File "/app/main.py", line 10, in <module>
    main()
  File "/app/lib/work.py", line 5, in main
    raise ValueError("boom")
ValueError: boom`

    const result = pythonTracebackParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({ kind: "text", content: "ValueError: boom" })
    const stack = result!.nodes[1]
    expect(stack.kind).toBe("stack")
    expect(stack.frames).toHaveLength(2)
    expect(stack.frames![0]).toMatchObject({
      file: "/app/main.py",
      line: 10,
      fn: "<module>",
      col: null,
    })
    expect(stack.frames![1]).toMatchObject({ file: "/app/lib/work.py", line: 5, fn: "main" })
  })

  it("returns null when there is no traceback header", () => {
    expect(pythonTracebackParser.parse('File "x.py", line 1, in f')).toBeNull()
  })

  it("returns null when the header is present but no frames parse", () => {
    expect(pythonTracebackParser.parse("Traceback (most recent call last):\n(none)")).toBeNull()
  })
})
