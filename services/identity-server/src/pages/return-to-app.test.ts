import { describe, expect, it } from "vitest"

import { call, pkcePair, signedInSession, SYNC_AUDIENCE } from "../../test/helpers"
import { isBrowserNavigation, isNativeAppRedirect, returnToAppPage } from "./return-to-app"

const TARGET = "cn.cognia.app:/auth/callback?code=c-1&state=s-1"

describe("returnToAppPage", () => {
  it("says the sign-in finished and opens the app, with a link for a dismissed prompt", async () => {
    const response = returnToAppPage(new Request("https://id.test/x"), TARGET)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    const html = await response.text()
    expect(html).toContain('data-mascot="happy"')
    expect(html).toContain("<h1>Signed in</h1>")
    expect(html).toContain(`href="cn.cognia.app:/auth/callback?code=c-1&amp;state=s-1"`)
    expect(html).toContain('"target":"cn.cognia.app:/auth/callback?code=c-1&state=s-1"')
    expect(html).toContain("window.location.replace(target)")
  })

  it("reports a refused sign-in in Chinese for a Chinese browser", async () => {
    const html = await returnToAppPage(
      new Request("https://id.test/x", { headers: { "accept-language": "zh-CN" } }),
      "cn.cognia.app:/auth/callback?error=access_denied&state=s-1"
    ).text()
    expect(html).toContain('data-mascot="worried"')
    expect(html).toContain("登录未完成")
    expect(html).toContain("打开 Cognia")
  })

  it("recognises only the app's own callback, and only a page load", () => {
    expect(isNativeAppRedirect(TARGET)).toBe(true)
    expect(isNativeAppRedirect("cn.cognia.app:/elsewhere?x=1")).toBe(false)
    expect(isNativeAppRedirect("http://127.0.0.1:9/callback?code=1")).toBe(false)
    expect(isNativeAppRedirect(null)).toBe(false)
    const req = (headers: Record<string, string>) => new Request("https://id.test/", { headers })
    expect(isBrowserNavigation(req({ "sec-fetch-mode": "navigate" }))).toBe(true)
    expect(isBrowserNavigation(req({ "sec-fetch-mode": "cors", accept: "text/html" }))).toBe(false)
    expect(isBrowserNavigation(req({ accept: "text/html,*/*" }))).toBe(true)
    expect(isBrowserNavigation(req({ accept: "application/json" }))).toBe(false)
  })
})

describe("a redirect to the native app through the Worker", () => {
  async function authorizeNative(headers: Record<string, string>) {
    const session = await signedInSession()
    const { challenge } = await pkcePair()
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "cognia-app",
      redirect_uri: "cn.cognia.app:/auth/callback",
      scope: "openid profile offline_access",
      state: "app-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: SYNC_AUDIENCE,
    })
    return call(`/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie: session.cookie, ...headers },
      redirect: "manual",
    })
  }

  it("lands a browser on the return page", async () => {
    const response = await authorizeNative({ accept: "text/html", "sec-fetch-mode": "navigate" })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toMatch(
      /href="cn\.cognia\.app:\/auth\/callback\?code=[^"]+&amp;state=app-state&amp;iss=/
    )
  })

  it("leaves an API call's answer alone", async () => {
    // A fetch gets Better Auth's JSON `{ redirect, url }`, never the page.
    const response = await authorizeNative({ accept: "application/json" })
    expect(response.headers.get("content-type")).toContain("application/json")
    const body = (await response.json()) as { url: string }
    expect(body.url).toMatch(/^cn\.cognia\.app:\/auth\/callback\?code=/)
  })
})
