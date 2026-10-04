import { describe, expect, it } from "vitest"

import { call } from "../../test/helpers"
import { errorPage, signedOutPage } from "./status-pages"

describe("error page", () => {
  it("explains an account that signs in another way", async () => {
    const response = errorPage(new Request("https://id.test/error?error=account_not_linked"))
    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain("already belongs to an account that signs in another way")
    expect(html).toContain("Error code: account_not_linked")
  })

  it("folds expired flows together and falls back to a generic message", async () => {
    expect(
      await errorPage(new Request("https://id.test/error?error=state_mismatch")).text()
    ).toContain("took too long")
    const generic = await errorPage(new Request("https://id.test/error?error=whatever")).text()
    expect(generic).toContain("Something went wrong")
  })

  it("never prints an error value that is not a plain code", async () => {
    const html = await errorPage(
      new Request(`https://id.test/error?error=${encodeURIComponent("<script>alert(1)</script>")}`)
    ).text()
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("Error code:")
  })

  it("says what to do next, under an error state tile", async () => {
    const html = await errorPage(new Request("https://id.test/error?error=access_denied")).text()
    expect(html).toContain('class="state error"')
    expect(html).toContain("<footer>Close this page and sign in again from Cognia.</footer>")
  })

  it("is served by the worker in Chinese", async () => {
    const html = await (
      await call("/error?error=access_denied", { headers: { "accept-language": "zh-CN" } })
    ).text()
    expect(html).toContain("已取消登录。")
  })
})

describe("signed-out page", () => {
  it("tells the person they can close the window", async () => {
    const html = await signedOutPage(new Request("https://id.test/signed-out")).text()
    expect(html).toContain("You are signed out")
  })
})
