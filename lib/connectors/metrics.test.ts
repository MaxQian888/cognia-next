import { CONNECTOR_METRIC_NAMES, recordConnectorMetric } from "./metrics"

describe("recordConnectorMetric", () => {
  it("fires the RPC for every allowlisted name and swallows failures", async () => {
    const call = jest.fn(async () => {
      throw new Error("companion down")
    }) as never
    for (const name of CONNECTOR_METRIC_NAMES) {
      recordConnectorMetric(name, { call })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((call as jest.Mock).mock.calls.map((c) => c[1])).toEqual(
      CONNECTOR_METRIC_NAMES.map((name) => ({ name }))
    )
  })

  it("ignores names outside the allowlist without calling the RPC", async () => {
    const call = jest.fn(async () => ({})) as never
    recordConnectorMetric("lark_made_up_total", { call })
    recordConnectorMetric("", { call })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).not.toHaveBeenCalled()
  })
})
