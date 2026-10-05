import { describe, expect, it } from "vitest"

import { call } from "../../test/helpers"
import { signInPage } from "./sign-in"

const providers = {
  providers: {
    feishu: { appId: "a", appSecret: "b" },
    github: { clientId: "c", clientSecret: "d" },
  },
}

function pageData(html: string): Record<string, unknown> | null {
  const match = /<script id="page-data" type="application\/json">(.*?)<\/script>/s.exec(html)
  return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : null
}

describe("sign-in page", () => {
  it("offers each configured provider when reached from an authorize request", async () => {
    const response = signInPage(
      new Request("https://id.test/sign-in?client_id=cognia-app&sig=x"),
      providers
    )
    const html = await response.text()
    expect(html).toContain('data-provider="feishu"')
    expect(html).toContain('data-provider="github"')
    expect(html).not.toContain('data-provider="google"')
    expect(pageData(html)).toMatchObject({ autoProvider: null })
    // A welcome icon; wide screens get the tagline beside the card.
    expect(html).toContain('data-icon="welcome"')
    expect(html).toContain("<h2>Your open workspace for AI agents</h2>")
    expect(html).toContain("<p>Choose how you want to sign in.</p>")
  })

  it("goes straight to the provider the app asked for", async () => {
    const html = await signInPage(
      new Request("https://id.test/sign-in?client_id=cognia-app&provider=feishu&sig=x"),
      providers
    ).text()
    expect(pageData(html)).toMatchObject({ autoProvider: "feishu" })
    // Buttons stay in the page, disabled, in case the redirect fails.
    expect(html).toContain('data-provider="feishu" disabled')
    // Going straight to the provider is a wait, and the icon shows it.
    expect(html).toContain('data-icon="waiting"')
  })

  it("ignores a provider this deployment does not offer", async () => {
    const html = await signInPage(
      new Request("https://id.test/sign-in?provider=google&sig=x"),
      providers
    ).text()
    expect(pageData(html)).toMatchObject({ autoProvider: null })
  })

  it("explains itself when opened without an authorize request", async () => {
    const html = await signInPage(
      new Request("https://id.test/sign-in?provider=feishu"),
      providers
    ).text()
    expect(html).toContain("Open Cognia and choose Sign in to continue.")
    expect(html).not.toContain("data-provider")
    expect(pageData(html)).toBeNull()
  })

  it("speaks Chinese to a Chinese browser", async () => {
    const html = await signInPage(
      new Request("https://id.test/sign-in?sig=x", {
        headers: { "accept-language": "zh-CN,zh;q=0.9" },
      }),
      providers
    ).text()
    expect(html).toContain("登录 Cognia")
    expect(html).toContain("使用飞书继续")
  })

  it("says so when no provider is configured", async () => {
    const html = await signInPage(new Request("https://id.test/sign-in?sig=x"), {
      providers: {},
    }).text()
    expect(html).toContain("Sign-in is not available right now.")
  })

  it("is served by the worker with its security headers", async () => {
    const response = await call("/sign-in?sig=x")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/)
    // The test environment configures Feishu and GitHub.
    const html = await response.text()
    expect(html).toContain('data-provider="feishu"')
    expect(html).toContain('data-provider="github"')
  })
})
