import type { SendOptions as AppSendOptions } from "@cognia/agent-config-types"
import type { SendOptions as SidecarSendOptions } from "../../sidecar/src/shared/wire/inbound.ts"

// This assignment is checked by root tsc; the sidecar cannot import the app's hub.
const acceptsAppOptions = (options: AppSendOptions): SidecarSendOptions => options

test("the app send envelope remains assignable to the sidecar wire contract", () => {
  const options: AppSendOptions = {
    model: "fixture",
    provider: "anthropic",
    turnId: "wire-contract",
  }
  expect(acceptsAppOptions(options)).toBe(options)
})
