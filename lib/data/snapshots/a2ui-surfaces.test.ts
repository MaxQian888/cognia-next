import {
  A2UI_SURFACES_LABEL_KEY,
  A2UI_SURFACES_PERSIST_KEY,
  a2uiSurfacesSnapshot,
} from "./a2ui-surfaces"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("a2uiSurfacesSnapshot", () => {
  it("uses the expected persist + label keys", () => {
    expect(a2uiSurfacesSnapshot.key).toBe(A2UI_SURFACES_PERSIST_KEY)
    expect(a2uiSurfacesSnapshot.labelKey).toBe(A2UI_SURFACES_LABEL_KEY)
    expect(a2uiSurfacesSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures and round-trips the persisted shape", () => {
    const payload = {
      state: {
        surfaces: {
          "panel:welcome": { id: "panel:welcome", appId: "welcome", visible: true },
        },
        activeSurfaceId: "panel:welcome",
        eventHistory: [{ id: "evt1", at: "2024-01-01T00:00:00.000Z" }],
      },
      version: 2,
    }
    const { storage, data } = createMemoryStorage({
      [A2UI_SURFACES_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    const snap = a2uiSurfacesSnapshot.read(env)
    expect(snap?.storeVersion).toBe(2)
    a2uiSurfacesSnapshot.write(snap!, "overwrite", env)
    expect(data.get(A2UI_SURFACES_PERSIST_KEY)).toBe(JSON.stringify(payload))
  })
})
