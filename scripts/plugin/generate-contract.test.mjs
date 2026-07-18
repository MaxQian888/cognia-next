import { readCatalog, renderPythonContract, renderRustContract } from "./generate-contract.mjs"
import { describe, test } from "node:test"
import assert from "node:assert/strict"

describe("plugin contract generator", () => {
  const catalog = readCatalog()

  test("renders the newly added contract values into both language mirrors", () => {
    const rust = renderRustContract(catalog)
    const python = renderPythonContract(catalog)

    assert.match(rust, /"context-panel"/)
    assert.match(rust, /"artifact:read"/)
    assert.match(rust, /"ipc:call"/)
    assert.match(rust, /"vscodeGrammars\[\]\.path"/)
    assert.match(rust, /\("context-panel", &\["contextPanels"\]\)/)
    assert.match(rust, /CAPABILITY_MINIMUM_HOST_VERSIONS/)
    assert.match(python, /"context-panel"/)
    assert.match(python, /"sessionImporters\[\]\.entry"/)
    assert.match(python, /"vscodeSnippets\[\]\.path"/)
    assert.match(python, /CAPABILITY_MINIMUM_HOST_VERSIONS/)
  })

  test("is deterministic", () => {
    assert.equal(renderRustContract(catalog), renderRustContract(catalog))
    assert.equal(renderPythonContract(catalog), renderPythonContract(catalog))
  })
})
