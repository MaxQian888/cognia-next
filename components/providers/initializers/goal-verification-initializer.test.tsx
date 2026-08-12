/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"

const reconcile = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/goal/verification", () => ({
  reconcilePendingGoalVerifications: () => reconcile(),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => 0 }))

import { GoalVerificationInitializer } from "./goal-verification-initializer"

it("reconciles durable verifier admissions once on boot", async () => {
  const { rerender } = render(<GoalVerificationInitializer />)
  rerender(<GoalVerificationInitializer />)
  await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
})
