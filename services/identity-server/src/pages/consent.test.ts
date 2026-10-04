import { describe, expect, it } from "vitest"

import { testEnv } from "../../test/helpers"
import { consentPage } from "./consent"

describe("consent page", () => {
  it("names the client and the scopes it asked for", async () => {
    const response = await consentPage(
      new Request(
        "https://id.test/consent?client_id=cognia-app&scope=openid%20profile%20offline_access%20bogus&sig=x"
      ),
      testEnv.DB
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("Allow Cognia to use your Cognia account?")
    expect(html).toContain("<li>Confirm who you are</li>")
    expect(html).toContain("<li>Keep you signed in</li>")
    expect(html).not.toContain("bogus")
    expect(html).toContain('data-accept="true"')
    expect(html).toContain('data-accept="false"')
  })

  it("refuses an unknown client or a request that did not come from authorize", async () => {
    expect(
      (await consentPage(new Request("https://id.test/consent?client_id=nobody&sig=x"), testEnv.DB))
        .status
    ).toBe(400)
    expect(
      (await consentPage(new Request("https://id.test/consent?client_id=cognia-app"), testEnv.DB))
        .status
    ).toBe(400)
  })

  it("speaks Chinese to a Chinese browser", async () => {
    const html = await (
      await consentPage(
        new Request("https://id.test/consent?client_id=cognia-app&scope=email&sig=x", {
          headers: { "accept-language": "zh" },
        }),
        testEnv.DB
      )
    ).text()
    expect(html).toContain("允许 Cognia 使用你的 Cognia 账号？")
    expect(html).toContain("<li>查看你的邮箱地址</li>")
  })
})
