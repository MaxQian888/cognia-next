import { buildRemoteVideoCancel } from "./cancel"

describe("remote video cancel", () => {
  it("builds each vendor's cancel request from the SDK operation", () => {
    expect(
      buildRemoteVideoCancel("replicate", {
        operation: { getUrl: "https://api.replicate.com/v1/predictions/p1" },
        apiKey: "r",
        baseURL: "https://api.replicate.com/v1",
      })
    ).toEqual({
      url: "https://api.replicate.com/v1/predictions/p1/cancel",
      method: "POST",
      headers: { Authorization: "Bearer r" },
    })
    expect(
      buildRemoteVideoCancel("fal", {
        operation: {
          responseUrl: "https://queue.fal.run/fal-ai/luma/requests/r1",
          submitUrl: "https://queue.fal.run/fal-ai/luma",
        },
        apiKey: "f",
        baseURL: "https://fal.run",
      })
    ).toEqual({
      url: "https://queue.fal.run/fal-ai/luma/requests/r1/cancel",
      method: "PUT",
      headers: { Authorization: "Key f" },
    })
    expect(
      buildRemoteVideoCancel("volcengine", {
        operation: { taskId: "t/1" },
        apiKey: "a",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3/",
      })
    ).toEqual({
      url: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/t%2F1",
      method: "DELETE",
      headers: { Authorization: "Bearer a" },
    })
    expect(
      buildRemoteVideoCancel("qwen", {
        operation: { taskId: "q1" },
        apiKey: "d",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })
    ).toEqual({
      url: "https://dashscope.aliyuncs.com/api/v1/tasks/q1/cancel",
      method: "POST",
      headers: { Authorization: "Bearer d" },
    })
  })

  it("never attaches a key to a URL outside the provider's origin", () => {
    expect(
      buildRemoteVideoCancel("replicate", {
        operation: { getUrl: "https://evil.test/v1/predictions/p1" },
        apiKey: "r",
        baseURL: "https://api.replicate.com/v1",
      })
    ).toBeNull()
    expect(
      buildRemoteVideoCancel("fal", {
        operation: { responseUrl: "https://evil.test/requests/r1" },
        apiKey: "f",
        baseURL: "https://fal.run",
      })
    ).toBeNull()
  })

  it("has no remote cancel for Google Veo or xAI, and none for a malformed operation", () => {
    expect(
      buildRemoteVideoCancel("xai", {
        operation: { requestId: "r" },
        apiKey: "x",
        baseURL: "https://api.x.ai/v1",
      })
    ).toBeNull()
    expect(
      buildRemoteVideoCancel("google", {
        operation: { operationName: "o" },
        apiKey: "g",
        baseURL: undefined,
      })
    ).toBeNull()
    expect(
      buildRemoteVideoCancel("doubao", { operation: null, apiKey: "a", baseURL: "https://x" })
    ).toBeNull()
  })
})
