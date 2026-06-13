import { defineUriHandler } from "./define-uri-handler"

describe("defineUriHandler", () => {
  it("returns the handler def unchanged", () => {
    const handle = jest.fn()
    const def = defineUriHandler({ id: "main", handle })
    expect(def.id).toBe("main")
    expect(def.handle).toBe(handle)
  })
})
