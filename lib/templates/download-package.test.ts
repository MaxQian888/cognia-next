/**
 * @jest-environment jsdom
 */

import { downloadTemplatePackage, templatePackageFilename } from "./download-package"

describe("templatePackageFilename", () => {
  it("names a package by its id and version", () => {
    expect(templatePackageFilename("legacy.agentTeam.abc", "1.2.0")).toBe(
      "legacy.agentTeam.abc-1.2.0.cognia-template"
    )
  })
})

describe("downloadTemplatePackage", () => {
  const createObjectURL = jest.fn(() => "blob:pkg")
  const revokeObjectURL = jest.fn()

  beforeEach(() => {
    jest.useFakeTimers()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true })
  })

  afterEach(() => jest.useRealTimers())

  it("clicks an in-document anchor and revokes the url on the next task", () => {
    const clicks: string[] = []
    const realCreate = document.createElement.bind(document)
    jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreate(tag)
      if (tag === "a") {
        // A click on a DETACHED anchor is ignored by some browsers, so the
        // assertion is about where the element is at click time.
        element.addEventListener("click", () => {
          clicks.push(element.isConnected ? "attached" : "detached")
        })
      }
      return element
    })

    downloadTemplatePackage(new Uint8Array([1, 2, 3]), "pack-1.0.0.cognia-template")

    expect(clicks).toEqual(["attached"])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    // Not revoked yet: doing it synchronously cancels the download in progress.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    jest.runAllTimers()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pkg")
    // The anchor does not outlive the click.
    expect(document.querySelector("a")).toBeNull()

    jest.restoreAllMocks()
  })
})
