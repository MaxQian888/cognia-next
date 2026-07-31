// SSR guards for the custom-CSS applier, split out of `apply.test.ts` on
// purpose: that file is jsdom-docblocked, and from Node 26 on jsdom's `document`
// is non-configurable, so the old `delete globalThis.document` trick throws
// `TypeError: Cannot delete property 'document' of #<Window>`. This file runs in
// the `node` project, where there genuinely is no document — a truer test of the
// branch than deleting one ever was.
import { applyUserCss, removeUserCss } from "./apply"

describe("custom-css SSR guards (no document)", () => {
  it("has no document to begin with", () => {
    expect(typeof document).toBe("undefined")
  })

  it("applyUserCss is a no-op without a document", () => {
    const res = applyUserCss(`a { color: red }`, true)
    expect(res.removedCount).toBe(0)
    expect(res.css).toBe(`a { color: red }`)
  })

  it("removeUserCss is a no-op without a document", () => {
    expect(() => removeUserCss()).not.toThrow()
  })
})
