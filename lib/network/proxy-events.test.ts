/**
 * @jest-environment jsdom
 */

import { NETWORK_PROXY_APPLIED_EVENT, notifyNetworkProxyApplied } from "./proxy-events"

it("emits the renderer proxy-applied signal", () => {
  const listener = jest.fn()
  window.addEventListener(NETWORK_PROXY_APPLIED_EVENT, listener)

  notifyNetworkProxyApplied()

  expect(listener).toHaveBeenCalledTimes(1)
  window.removeEventListener(NETWORK_PROXY_APPLIED_EVENT, listener)
})
