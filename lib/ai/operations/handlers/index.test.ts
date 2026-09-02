import { ProviderOperationHandlerRegistry } from "../registry"
import {
  BUILT_IN_PROVIDER_OPERATION_HANDLERS,
  registerBuiltInProviderOperationHandlers,
} from "./index"

describe("registerBuiltInProviderOperationHandlers", () => {
  it("registers every built-in handler once per registry", () => {
    const registry = new ProviderOperationHandlerRegistry()
    registerBuiltInProviderOperationHandlers(registry)
    registerBuiltInProviderOperationHandlers(registry)
    expect(registry.list()).toHaveLength(BUILT_IN_PROVIDER_OPERATION_HANDLERS.length)
    expect(registry.resolve("capabilities.read", "anything", "openai")).toBeDefined()
  })
})
