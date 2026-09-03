import * as artifacts from "./index"
import * as constants from "./constants"
import * as chartContract from "./chart-contract"
import * as utils from "./utils"
import * as preview from "./preview-utils"
import * as diff from "./diff"
import * as srcMeta from "./source-metadata"
import * as reveal from "./reveal"
import * as renderer from "./renderer-registry"

describe("artifacts barrel re-exports", () => {
  it("includes every named export from each child module", () => {
    for (const child of [
      constants,
      chartContract,
      utils,
      preview,
      diff,
      srcMeta,
      reveal,
      renderer,
    ]) {
      for (const key of Object.keys(child)) {
        if (key === "default") continue
        expect(artifacts).toHaveProperty(key)
      }
    }
  })
})
