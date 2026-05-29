import { useDevProjectStore } from "./dev-project-store"

describe("useDevProjectStore", () => {
  beforeEach(() => {
    useDevProjectStore.getState().clearProject()
  })

  it("sets and reads the project dir + name", () => {
    useDevProjectStore.getState().setProject("/proj", "My Plugin")
    expect(useDevProjectStore.getState().projectDir).toBe("/proj")
    expect(useDevProjectStore.getState().projectName).toBe("My Plugin")
  })

  it("defaults the name to null when omitted", () => {
    useDevProjectStore.getState().setProject("/proj")
    expect(useDevProjectStore.getState().projectName).toBeNull()
  })

  it("clears the project back to null", () => {
    useDevProjectStore.getState().setProject("/proj", "X")
    useDevProjectStore.getState().clearProject()
    expect(useDevProjectStore.getState().projectDir).toBeNull()
    expect(useDevProjectStore.getState().projectName).toBeNull()
  })
})
