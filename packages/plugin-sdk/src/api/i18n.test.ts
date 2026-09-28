beforeEach(() => jest.resetModules())

test("uses the host translation hook while retaining registry exports", async () => {
  const facade = await import("./i18n")
  expect(() => facade.usePluginTranslations("fixture-plugin")).toThrow("require the Cognia host")
  const translate = jest.fn((key: string) => key)
  const hook = jest.fn(() => translate)
  facade.bindPluginTranslationsHost(hook)
  expect(facade.usePluginTranslations("fixture-plugin")).toBe(translate)
  expect(hook).toHaveBeenCalledWith("fixture-plugin")
  expect(typeof facade.registerPluginI18n).toBe("function")
  expect(typeof facade.unregisterPluginI18n).toBe("function")
})
