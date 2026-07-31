import {
  readCatalog,
  renderPythonContract,
  renderRustContract,
  validateAgainstSchema,
} from "./generate-contract.mjs"
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
    assert.match(rust, /MANIFEST_CONTRIBUTIONS/)
    assert.match(rust, /RUNTIME_ENTRY_CONTRACTS/)
    assert.match(rust, /vscodeExtension\.contributes\.chatInstructions/)
    assert.match(python, /"context-panel"/)
    assert.match(python, /"sessionImporters\[\]\.entry"/)
    assert.match(python, /"vscodeSnippets\[\]\.path"/)
    assert.match(python, /CAPABILITY_MINIMUM_HOST_VERSIONS/)
    assert.match(python, /MANIFEST_CONTRIBUTIONS/)
    assert.match(python, /RUNTIME_ENTRY_CONTRACTS/)
    assert.match(python, /"javascriptEntry": None/)
    assert.doesNotMatch(python, /:\s*(?:null|true|false)\b/)
  })

  test("is deterministic", () => {
    assert.equal(renderRustContract(catalog), renderRustContract(catalog))
    assert.equal(renderPythonContract(catalog), renderPythonContract(catalog))
  })

  test("rejects schema-invalid catalogs before rendering", () => {
    const schema = {
      type: "object",
      required: ["requiredValue"],
      properties: { requiredValue: { type: "string" } },
      additionalProperties: false,
    }
    assert.throws(
      () => validateAgainstSchema({ requiredValue: 1 }, schema),
      /requiredValue must be string/
    )
    assert.throws(
      () => validateAgainstSchema({ requiredValue: "ok", unexpected: true }, schema),
      /unexpected is not allowed/
    )
  })
})
