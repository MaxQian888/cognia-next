import { generateAppFromDescription } from "./index"

describe("generateAppFromDescription", () => {
  it("dispatches detected weather intent to the existing weather template", () => {
    const app = generateAppFromDescription({ description: "Show me a weather dashboard" })

    expect(app.name).toBe("Weather")
    expect(app.components.find((component) => component.id === "weather-icon")).toBeDefined()
    expect(app.dataModel).toHaveProperty("weather.temperature")
  })

  it("localizes weather payloads for a Chinese generation request", () => {
    const app = generateAppFromDescription({ description: "创建一个天气小组件" })

    expect(app.components.find(({ id }) => id === "humidity-label")).toMatchObject({
      text: "💧 湿度",
    })
    expect(app.dataModel).toMatchObject({
      weather: { condition: "局部多云", location: "美国加利福尼亚州旧金山" },
    })
  })

  it("keeps temperature conversion more specific than the overlapping weather keyword", () => {
    const app = generateAppFromDescription({ description: "Build a temperature converter" })

    expect(app.dataModel).toMatchObject({ converterType: "temperature" })
    expect(app.components.find((component) => component.id === "from-unit")).toBeDefined()
    expect(app.components.find((component) => component.id === "weather-icon")).toBeUndefined()
  })

  it("routes the specific contact-form intent before the generic form keyword", () => {
    const app = generateAppFromDescription({ description: "Create a contact form", language: "en" })

    expect(app.components.find(({ id }) => id === "first-name")).toBeDefined()
    expect(app.components.find(({ id }) => id === "q1")).toBeUndefined()
  })
})
