import {
  createGenerationContext,
  detectAppType,
  detectLanguage,
  extractAppName,
  getLocalizedTexts,
  getStyleConfig,
} from "./config"

describe("A2UI generator configuration", () => {
  it("resolves localized copy and visual style tables", () => {
    expect(getLocalizedTexts("zh").submit).toBe("提交")
    expect(getLocalizedTexts("en").submit).toBe("Submit")
    expect(getStyleConfig("minimal").buttonVariant).toBe("outline")
    expect(getStyleConfig("professional").buttonVariant).toBe("secondary")
  })

  it.each([
    ["build a calculator", "calculator"],
    ["创建一个倒计时", "timer"],
    ["weather forecast", "weather"],
    ["unmatched experience", null],
  ])("detects an app family from %s", (description, expected) => {
    expect(detectAppType(description)).toBe(expected)
  })

  it("detects language and preserves explicit generation options", () => {
    expect(detectLanguage("创建应用")).toBe("zh")
    expect(detectLanguage("create app")).toBe("en")
    expect(
      createGenerationContext({ description: "创建应用", language: "en", style: "minimal" })
    ).toMatchObject({ language: "en", style: "minimal", texts: { submit: "Submit" } })
  })

  it("extracts an explicit name and otherwise uses localized app-family names", () => {
    expect(extractAppName("创建一个预算计算器")).toBe("预算计算器")
    const english = createGenerationContext({ description: "build weather", language: "en" })
    expect(extractAppName("weather forecast", english)).toBe("Weather")
    expect(extractAppName("something unique", english)).toBe("My App")
  })
})
