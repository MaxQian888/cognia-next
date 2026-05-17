import * as React from "react"

// Shared Jest manual mock for `@/components/ui/sonner`.
//   - `Toaster` is a transparent placeholder div so apps that render it at
//     the layout root don't crash under JSDOM.
//   - `toast` is the same module-scope singleton that the real sonner
//     ships, but every method is a `jest.fn()` so tests can spy:
//         expect(toast.success).toHaveBeenCalledWith(...)
//     Call `jest.clearAllMocks()` (or set `clearMocks: true` in jest
//     config) between tests to reset call history. Tests with bespoke
//     assertion semantics should keep their inline factory.

type Props = React.HTMLAttributes<HTMLDivElement>

export function Toaster(props: Props) {
  return <div data-testid="toaster" {...props} />
}

type ToastFn = jest.Mock<unknown, unknown[]>

type ToastApi = ToastFn & {
  success: ToastFn
  error: ToastFn
  info: ToastFn
  warning: ToastFn
  message: ToastFn
  loading: ToastFn
  dismiss: ToastFn
  promise: ToastFn
  custom: ToastFn
}

export const toast = Object.assign(jest.fn(), {
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  message: jest.fn(),
  loading: jest.fn(),
  dismiss: jest.fn(),
  promise: jest.fn(),
  custom: jest.fn(),
}) as ToastApi
