import * as editor from "./editor"
import type {
  ActiveEditorContext,
  PluginActiveEditorContext,
  PluginEditorAPI,
  PluginEditorOpenOptions,
  PluginEditorOpenResult,
} from "./editor"

describe("plugin-sdk api/editor", () => {
  it("is a type-only public contract with no host runtime implementation", () => {
    expect(editor).toEqual({})
  })

  it("re-exports the complete editor API contract", () => {
    const assertTypes = <
      _Api extends PluginEditorAPI,
      _Context extends PluginActiveEditorContext,
      _Active extends ActiveEditorContext,
      _Options extends PluginEditorOpenOptions,
      _Result extends PluginEditorOpenResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
