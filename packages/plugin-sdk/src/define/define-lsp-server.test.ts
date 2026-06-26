import { defineLspServer } from "./define-lsp-server"

describe("defineLspServer", () => {
  it("returns the LSP server definition unchanged (pure pass-through)", () => {
    const def = defineLspServer({
      id: "my-lsp",
      name: "My Language Server",
      languages: ["mylang"],
      command: "my-langserver",
      args: ["--stdio"],
    })
    expect(def).toMatchObject({
      id: "my-lsp",
      name: "My Language Server",
      command: "my-langserver",
    })
    expect(def.languages).toEqual(["mylang"])
  })

  it("preserves object identity (no copy, no validation)", () => {
    const input = {
      id: "bare-lsp",
      name: "Bare",
      languages: ["plaintext"],
      command: "bare-langserver",
    }
    expect(defineLspServer(input)).toBe(input)
  })
})
