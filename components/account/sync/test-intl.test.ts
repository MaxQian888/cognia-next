import { echoTranslations } from "./test-intl"

describe("echoTranslations", () => {
  it("echoes keys and values", () => {
    const t = echoTranslations()
    expect(t("a.b")).toBe("a.b")
    expect(t("a.c", { n: 2, m: "x" })).toBe("a.c(2,x)")
    expect(t.has()).toBe(true)
  })
})
