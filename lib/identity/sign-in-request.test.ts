/** @jest-environment jsdom */
import { requestCloudSignIn, subscribeCloudSignInRequest } from "./sign-in-request"

describe("the sign-in request bus", () => {
  it("delivers a request to every subscriber until it unsubscribes", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeCloudSignInRequest(listener)
    requestCloudSignIn("acct_a")
    expect(listener).toHaveBeenCalledWith({ localAccountId: "acct_a" })
    unsubscribe()
    requestCloudSignIn("acct_a")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores a foreign event of the same name without a profile", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeCloudSignInRequest(listener)
    window.dispatchEvent(new CustomEvent("cognia:cloud-sign-in-request", { detail: {} }))
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
