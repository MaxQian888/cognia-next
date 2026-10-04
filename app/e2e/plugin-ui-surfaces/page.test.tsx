const missing = jest.fn(() => {
  throw new Error("not-found")
})
const dynamicMock = jest.fn(
  (..._args: unknown[]) =>
    () =>
      null
)
jest.mock("next/navigation", () => ({ notFound: () => missing() }))
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (...args: unknown[]) => dynamicMock(...args),
}))

const previous = process.env.NEXT_PUBLIC_E2E

afterEach(() => {
  process.env.NEXT_PUBLIC_E2E = previous
  jest.resetModules()
  missing.mockClear()
  dynamicMock.mockClear()
})

it("does not initialize the fixture loader in ordinary production builds", () => {
  process.env.NEXT_PUBLIC_E2E = "0"
  const Page = jest.requireActual("./page").default
  expect(() => Page()).toThrow("not-found")
  expect(dynamicMock).not.toHaveBeenCalled()
})

it("retains the fixture loader for explicitly enabled E2E builds", () => {
  process.env.NEXT_PUBLIC_E2E = "1"
  const Page = jest.requireActual("./page").default
  expect(Page()).toBeTruthy()
  expect(dynamicMock).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ ssr: false })
  )
  expect(missing).not.toHaveBeenCalled()
})
