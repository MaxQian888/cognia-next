/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const openUrlMock = jest.fn()
jest.mock("@/lib/native/opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }))

import { KeyLoginRow } from "./key-login-row"

import type { ApiKeyValidationResult } from "@cognia/provider-core/providers/api-key-login"

beforeEach(() => {
  openUrlMock.mockReset()
})

const validate = (result: ApiKeyValidationResult) => jest.fn(async () => result)

describe("KeyLoginRow", () => {
  it("opens the provider's own console page", () => {
    render(<KeyLoginRow providerId="moonshot" apiKey="sk-1" />)
    fireEvent.click(screen.getByTestId("key-login-open-console"))
    expect(openUrlMock).toHaveBeenCalledWith("https://platform.moonshot.cn/console/api-keys")
  })

  it("sends a coding-plan relay to the console of the vendor it deploys", () => {
    // Before the vendor fallback these rendered a Verify button with no way to
    // find out where the key even comes from.
    render(<KeyLoginRow providerId="glm-anthropic" apiKey="sk-1" />)
    fireEvent.click(screen.getByTestId("key-login-open-console"))
    expect(openUrlMock).toHaveBeenCalledWith("https://open.bigmodel.cn/usercenter/apikeys")
    expect(screen.getByTestId("key-login-open-console")).toHaveTextContent("Get a key")
  })

  it("does not call a vendor platform page a key page", () => {
    // `packycode` has no console anywhere in the catalog, so the link lands on
    // the vendor's front door. Labelling that "Get a key" would promise a page
    // it cannot point at.
    render(<KeyLoginRow providerId="packycode" apiKey="sk-1" />)
    expect(screen.getByTestId("key-login-open-console")).toHaveTextContent("Open console")
  })

  it("reports a key the provider accepted", async () => {
    render(
      <KeyLoginRow providerId="moonshot" apiKey="sk-1" validate={validate({ status: "valid" })} />
    )
    fireEvent.click(screen.getByTestId("key-login-verify"))
    await waitFor(() => expect(screen.getByTestId("key-login-valid")).toBeInTheDocument())
  })

  it("reports a rejected key and keeps the provider's own reason", async () => {
    render(
      <KeyLoginRow
        providerId="moonshot"
        apiKey="sk-bad"
        validate={validate({ status: "invalid", message: "invalid api key" })}
      />
    )
    fireEvent.click(screen.getByTestId("key-login-verify"))
    await waitFor(() => expect(screen.getByTestId("key-login-invalid")).toBeInTheDocument())
    expect(screen.getByTestId("key-login-invalid")).toHaveAttribute("title", "invalid api key")
  })

  it("distinguishes could-not-verify from rejected", async () => {
    // Being offline says nothing about the key. Showing it as rejected would
    // push the user to replace a credential that is probably fine.
    render(
      <KeyLoginRow
        providerId="moonshot"
        apiKey="sk-1"
        validate={validate({ status: "unverified", message: "offline" })}
      />
    )
    fireEvent.click(screen.getByTestId("key-login-verify"))
    await waitFor(() => expect(screen.getByTestId("key-login-unverified")).toBeInTheDocument())
    expect(screen.queryByTestId("key-login-invalid")).not.toBeInTheDocument()
  })

  it("cannot verify when there is no key saved yet", () => {
    render(<KeyLoginRow providerId="moonshot" />)
    expect(screen.getByTestId("key-login-verify")).toBeDisabled()
  })

  it("renders nothing for a provider with no console page and no probe", () => {
    // A local runtime has nothing to log in to, so mounting this for every
    // built-in must stay free.
    const { container } = render(<KeyLoginRow providerId="ollama" apiKey="x" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("covers a provider whose login is derived rather than hand-written", () => {
    // Nothing was authored for Zhipu. The console page and the probe both come
    // from its existing catalog entry.
    render(<KeyLoginRow providerId="zhipu" apiKey="sk-1" />)
    expect(screen.getByTestId("key-login-open-console")).toBeInTheDocument()
    expect(screen.getByTestId("key-login-verify")).toBeEnabled()
  })
})
