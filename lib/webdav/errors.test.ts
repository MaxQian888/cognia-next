import { NATIVE_CERTIFICATE_OVERRIDE_UNAVAILABLE, WebDavError, webDavErrorMessage } from "./errors"

it("localizes unsupported certificate policy across typed and serialized failures", () => {
  const message = "Use a trusted certificate"
  expect(
    webDavErrorMessage(new WebDavError(NATIVE_CERTIFICATE_OVERRIDE_UNAVAILABLE, 0), message)
  ).toBe(message)
  expect(webDavErrorMessage(NATIVE_CERTIFICATE_OVERRIDE_UNAVAILABLE, message)).toBe(message)
})

it("preserves unrelated server errors", () => {
  expect(webDavErrorMessage(new WebDavError("Unauthorized", 401), "override unsupported")).toBe(
    "Unauthorized"
  )
})
