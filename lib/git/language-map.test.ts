import { languageFromPath } from "./language-map"

describe("languageFromPath", () => {
  it("maps common extensions", () => {
    expect(languageFromPath("src/a.ts")).toBe("typescript")
    expect(languageFromPath("c.tsx")).toBe("typescript")
    expect(languageFromPath("x/y/main.rs")).toBe("rust")
    expect(languageFromPath("styles.css")).toBe("css")
    expect(languageFromPath("README.md")).toBe("markdown")
    expect(languageFromPath("data.json")).toBe("json")
  })

  it("recognizes well-known filenames", () => {
    expect(languageFromPath("Dockerfile")).toBe("dockerfile")
    expect(languageFromPath("path/to/Makefile")).toBe("makefile")
    expect(languageFromPath(".gitignore")).toBe("ignore")
  })

  it("falls back to plaintext", () => {
    expect(languageFromPath("LICENSE")).toBe("plaintext")
    expect(languageFromPath("weird.unknownext")).toBe("plaintext")
    expect(languageFromPath("noextension")).toBe("plaintext")
  })

  it("is case-insensitive on extension", () => {
    expect(languageFromPath("A.TS")).toBe("typescript")
  })
})
