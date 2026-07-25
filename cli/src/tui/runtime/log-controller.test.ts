import { logsPanel } from "./log-controller"
import type { TuiAction } from "../state/types"

describe("logsPanel", () => {
  it("opens the unified log overlay", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    logsPanel({ dispatch })
    expect(dispatch).toHaveBeenCalledWith({ type: "OVERLAY_OPEN", overlay: { kind: "logs" } })
  })
})
