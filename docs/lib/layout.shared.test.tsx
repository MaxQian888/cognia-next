jest.mock("fumadocs-ui/i18n", () => ({
  defineI18nUI: jest.fn(() => ({})),
}))
jest.mock("../../lib/i18n", () => ({ i18n: {} }), { virtual: true })

import { baseOptions } from "./layout.shared"

describe("docs layout branding", () => {
  it("uses the Cognia product name in navigation", () => {
    expect(baseOptions("en").nav?.title).toBe("Cognia")
  })
})
