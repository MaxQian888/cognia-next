import { injectFrameCsp, injectFrameHead, serializeFrameCsp } from "./frame-csp"

describe("serializeFrameCsp", () => {
  it("joins directives in the order given", () => {
    expect(
      serializeFrameCsp([
        ["default-src", "'none'"],
        ["script-src", "'unsafe-inline'"],
      ])
    ).toBe("default-src 'none'; script-src 'unsafe-inline'")
  })
})

describe("injectFrameCsp", () => {
  it("puts the meta first inside an existing head", () => {
    const out = injectFrameCsp(
      "<html><head><title>t</title></head><body>x</body></html>",
      "default-src 'none'"
    )
    expect(out).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>`
    )
  })

  it("preserves attributes on the head tag", () => {
    const out = injectFrameCsp('<html><head lang="en"></head></html>', "default-src 'none'")
    expect(out).toContain('<head lang="en"><meta http-equiv="Content-Security-Policy"')
  })

  it("wraps a fragment that has no head at all", () => {
    const out = injectFrameCsp("<p>hi</p>", "default-src 'none'")
    expect(out.startsWith("<!doctype html><html><head><meta")).toBe(true)
    expect(out).toContain("<body><p>hi</p></body>")
  })

  it("escapes a double quote so the policy cannot break out of the attribute", () => {
    // A policy that carried a raw `"` would close the attribute and leave the
    // remainder of the policy parsed as markup — i.e. no policy at all.
    const out = injectFrameCsp("<html><head></head></html>", `script-src 'self' "evil"`)
    expect(out).toContain("content=\"script-src 'self' &quot;evil&quot;\"")
    expect(out.match(/content="/g)).toHaveLength(1)
  })

  it("is case-insensitive about the head tag", () => {
    expect(injectFrameCsp("<HTML><HEAD></HEAD></HTML>", "default-src 'none'")).toContain(
      "<HEAD><meta http-equiv"
    )
  })
})

describe("injectFrameHead", () => {
  it("puts arbitrary markup first inside the head", () => {
    // The bootstrap script has to precede the artifact's own content, or the
    // content runs before anything is listening.
    const out = injectFrameHead(
      "<html><head><title>t</title></head></html>",
      "<script src='x'></script>"
    )
    expect(out).toContain("<head><script src='x'></script><title>")
  })

  it("wraps a fragment that has no head", () => {
    expect(injectFrameHead("<p>hi</p>", "<base>")).toBe(
      "<!doctype html><html><head><base></head><body><p>hi</p></body></html>"
    )
  })
})
