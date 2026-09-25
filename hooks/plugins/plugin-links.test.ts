import { pluginDetailHref, pluginEnableFailureToastId } from "./plugin-links"

describe("pluginDetailHref", () => {
  it("builds the deep link the URL sync resolves", () => {
    expect(pluginDetailHref("a b")).toBe("/plugins?plugin=a+b")
    expect(pluginDetailHref("x", "capabilities")).toBe("/plugins?plugin=x&subtab=capabilities")
  })
})

describe("pluginEnableFailureToastId", () => {
  it("keys one failure of one plugin", () => {
    expect(pluginEnableFailureToastId("p", "boom")).toBe("p::boom")
  })
})
