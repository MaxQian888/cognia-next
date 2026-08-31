/** @jest-environment jsdom */

import { downloadBlob } from "./download"

describe("downloadBlob", () => {
  it("clicks a temporary anchor and revokes the object URL", () => {
    const createObjectURL = jest.fn(() => "blob:plugin-export")
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation()

    downloadBlob("report.json", new Blob(["{}"], { type: "application/json" }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:plugin-export")
    expect(document.querySelector("a[download='report.json']")).toBeNull()
    click.mockRestore()
  })
})
