jest.mock("storybook/test", () => ({ fn: () => jest.fn() }))

import meta, { EditMode, ReadMode } from "./mobile-editor-topbar.stories"

describe("MobileEditorTopbar stories", () => {
  it("keeps both read/edit variants wired to the Workbench action", () => {
    expect(meta.args.onOpenWorkbench).toEqual(expect.any(Function))
    expect(ReadMode.args).toBeUndefined()
    expect(EditMode.args).toMatchObject({ mode: "edit" })
  })
})
