import { writeText, readText, type ClipboardLoader } from "./clipboard"

function makeLoader(impl: Partial<Record<"write" | "read", unknown>> = {}): ClipboardLoader {
  return async () =>
    ({
      write: async () => {},
      read: async () => ({ value: "from clipboard", type: "text/plain" }),
      ...impl,
    }) as unknown as Awaited<ReturnType<ClipboardLoader>>
}

describe("lib/capacitor/clipboard", () => {
  describe("writeText", () => {
    it("writes the string through the native plugin", async () => {
      const write = jest.fn(async () => {})
      const out = await writeText("hi", makeLoader({ write }))
      expect(out.kind).toBe("ok")
      expect(write).toHaveBeenCalledWith({ string: "hi" })
    })

    it("returns unsupported when the plugin cannot load", async () => {
      const out = await writeText("hi", async () => {
        throw new Error("not on platform")
      })
      expect(out.kind).toBe("unsupported")
    })

    it("returns error when the native write throws", async () => {
      const out = await writeText(
        "hi",
        makeLoader({
          write: async () => {
            throw new Error("denied")
          },
        })
      )
      expect(out.kind).toBe("error")
      if (out.kind !== "error") return
      expect(out.message).toMatch(/denied/)
    })
  })

  describe("readText", () => {
    it("reads the clipboard value", async () => {
      const out = await readText(makeLoader())
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      expect(out.value).toBe("from clipboard")
    })

    it("coerces a missing value to an empty string", async () => {
      const out = await readText(makeLoader({ read: async () => ({}) }))
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      expect(out.value).toBe("")
    })

    it("returns unsupported when the plugin cannot load", async () => {
      const out = await readText(async () => {
        throw new Error("not on platform")
      })
      expect(out.kind).toBe("unsupported")
    })
  })
})
