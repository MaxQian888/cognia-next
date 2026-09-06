import { CloudDeploymentCard } from "./cloud-deployment-card"
import { LogtoLoginCard, extractCallback } from "./logto-login-card"
import { extractCallback as movedExtractCallback } from "@/lib/logto/extract-callback"

describe("logto-login-card compatibility surface", () => {
  it("names the deployment card and the moved extractor", () => {
    expect(LogtoLoginCard).toBe(CloudDeploymentCard)
    expect(extractCallback).toBe(movedExtractCallback)
  })
})
