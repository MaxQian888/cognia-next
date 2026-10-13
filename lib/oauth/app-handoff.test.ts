import { appHandoffFor, feishuWebUrlApplink } from "./app-handoff"

const authorize =
  "https://id.cognia.cn/api/auth/oauth2/authorize?response_type=code&client_id=cognia-app" +
  "&redirect_uri=cn.cognia.app%3A%2Fauth%2Fcallback&state=s%2B1&provider=feishu&prompt=login"

describe("appHandoffFor", () => {
  it("hands a Feishu sign-in to the Feishu app with the whole authorize request", () => {
    const handoff = appHandoffFor(authorize)
    expect(handoff?.target).toBe("feishu")
    const link = new URL(handoff!.url)
    expect(`${link.origin}${link.pathname}`).toBe("https://applink.feishu.cn/client/web_url/open")
    expect(link.searchParams.get("mode")).toBe("window")
    // Decoding the Applink once gives back the authorize URL byte for byte,
    // so its own encoded values (the redirect URI, the state) survive.
    expect(link.searchParams.get("url")).toBe(authorize)
  })

  it("leaves other providers and plain requests to the browser", () => {
    expect(appHandoffFor(authorize.replace("provider=feishu", "provider=github"))).toBeNull()
    expect(appHandoffFor(authorize.replace("&provider=feishu", ""))).toBeNull()
    expect(appHandoffFor("not a url")).toBeNull()
  })
})

describe("feishuWebUrlApplink", () => {
  it("encodes the page URL exactly once", () => {
    const link = feishuWebUrlApplink("https://example.com/a?x=1%262&y=2")
    expect(link).toBe(
      "https://applink.feishu.cn/client/web_url/open?mode=window&url=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%25262%26y%3D2"
    )
  })
})
