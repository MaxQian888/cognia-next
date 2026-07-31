import { defineExtension } from "./define-extension"

describe("defineExtension", () => {
  it("preserves a declarative extension definition", () => {
    const extension = defineExtension({
      point: "chat.input.actions",
      entry: "dist/surfaces.js",
      export: "ComposerAction",
      priority: 20,
      when: "chat.active",
      minWidth: 32,
      maxWidth: 48,
      labelKey: "surfaces.composerAction",
    })

    expect(extension).toEqual({
      point: "chat.input.actions",
      entry: "dist/surfaces.js",
      export: "ComposerAction",
      priority: 20,
      when: "chat.active",
      minWidth: 32,
      maxWidth: 48,
      labelKey: "surfaces.composerAction",
    })
  })
})
