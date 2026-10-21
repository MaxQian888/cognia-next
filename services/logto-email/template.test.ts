/** @jest-environment node */

import { CODE_TTL_SECONDS, renderEmail } from "./template"

test("renders matching HTML and plain text without leaking the OTP into the subject or preview", () => {
  const message = renderEmail(
    { to: "person@example.com", type: "SignIn", code: "012345", locale: "en" },
    "login@status.cognia.cn"
  )
  expect(message.text).toContain("012345")
  expect(message.html).toContain(">012345</div>")
  expect(message.text).toContain("5 minutes")
  expect(CODE_TTL_SECONDS).toBe(300)
  expect(message.subject).not.toContain("012345")
  expect(message.html.split("<!-- /preheader -->")[0]).not.toContain("012345")
  expect(message.html).not.toMatch(/<script|<img|https?:\/\//)
  expect(message.html).toContain('role="presentation"')
  expect(message.html).toContain("prefers-color-scheme: dark")
})

test.each(["SignIn", "Register", "ForgotPassword", "Generic"] as const)(
  "renders Chinese and English copy for %s",
  (type) => {
    const zh = renderEmail(
      { to: "p@example.com", type, code: "123456", locale: "zh" },
      "s@test.com"
    )
    const en = renderEmail(
      { to: "p@example.com", type, code: "123456", locale: "en" },
      "s@test.com"
    )
    expect(zh.subject).toMatch(/Cognia/)
    expect(zh.html).toContain('lang="zh-CN"')
    expect(zh.text).toContain("5 分钟")
    expect(en.html).toContain('lang="en"')
    expect(en.text).toContain("5 minutes")
  }
)

test("escapes interpolated content and keeps all digits together for copying", () => {
  const message = renderEmail(
    { to: "p@example.com", type: "Generic", code: '<img src="x">', locale: "en" },
    "s@test.com"
  )
  expect(message.html).not.toContain('<img src="x">')
  expect(message.html).toContain("&lt;img")
})
