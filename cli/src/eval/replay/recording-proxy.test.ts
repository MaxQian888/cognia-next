import { createRecordingProxy } from "./recording-proxy"

describe("createRecordingProxy", () => {
  it("blocks a provider request containing PII before forwarding it", async () => {
    const fetchImpl = jest.fn()
    const proxy = createRecordingProxy({ fetchImpl: fetchImpl as typeof fetch })
    await proxy.start()

    try {
      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-test",
          messages: [{ role: "user", content: "Email alice@example.com" }],
        }),
      })

      expect(response.status).toBe(502)
      await expect(response.text()).resolves.toContain("PII gate")
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      await proxy.stop()
    }
  })
})
