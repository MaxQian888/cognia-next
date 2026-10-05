import { EnrollmentError } from "./errors"

describe("EnrollmentError", () => {
  it("carries its code", () => {
    const error = new EnrollmentError("busy", "try again")
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: "EnrollmentError", code: "busy", message: "try again" })
  })
})
