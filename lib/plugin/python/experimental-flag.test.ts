import {
  __resetExperimentalPythonFlagForTesting,
  canRunPythonBackedContribution,
  isExperimentalPythonBackedEnabled,
  isExperimentalPythonContribution,
  setExperimentalPythonBackedEnabled,
} from "./experimental-flag"

describe("experimental python-backed flag", () => {
  beforeEach(() => {
    __resetExperimentalPythonFlagForTesting()
  })

  it("ships off by default", () => {
    expect(isExperimentalPythonBackedEnabled()).toBe(false)
  })

  it("reads experimental-ness from the capability contract, not a hand-kept list", () => {
    // The three capabilities the catalog marks `pythonExecution: "experimental"`.
    expect(isExperimentalPythonContribution("connectors")).toBe(true)
    expect(isExperimentalPythonContribution("chatMiddlewares")).toBe(true)
    expect(isExperimentalPythonContribution("terminalCompletionProviders")).toBe(true)

    // A `supported` capability is not gated…
    expect(isExperimentalPythonContribution("ocrProviders")).toBe(false)
    expect(isExperimentalPythonContribution("aiProviders")).toBe(false)
    // …nor is a JS-only or unknown field.
    expect(isExperimentalPythonContribution("views")).toBe(false)
    expect(isExperimentalPythonContribution("nope")).toBe(false)
  })

  it("lets supported capabilities run regardless of the flag", () => {
    expect(canRunPythonBackedContribution("ocrProviders")).toBe(true)
    setExperimentalPythonBackedEnabled(true)
    expect(canRunPythonBackedContribution("ocrProviders")).toBe(true)
  })

  it("gates experimental capabilities behind the flag", () => {
    expect(canRunPythonBackedContribution("connectors")).toBe(false)
    expect(canRunPythonBackedContribution("chatMiddlewares")).toBe(false)
    expect(canRunPythonBackedContribution("terminalCompletionProviders")).toBe(false)

    setExperimentalPythonBackedEnabled(true)
    expect(isExperimentalPythonBackedEnabled()).toBe(true)
    expect(canRunPythonBackedContribution("connectors")).toBe(true)
    expect(canRunPythonBackedContribution("chatMiddlewares")).toBe(true)
    expect(canRunPythonBackedContribution("terminalCompletionProviders")).toBe(true)
  })

  it("resets to the shipped default", () => {
    setExperimentalPythonBackedEnabled(true)
    __resetExperimentalPythonFlagForTesting()
    expect(isExperimentalPythonBackedEnabled()).toBe(false)
    expect(canRunPythonBackedContribution("connectors")).toBe(false)
  })
})
