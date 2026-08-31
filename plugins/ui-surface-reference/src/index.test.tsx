import { render, screen } from "@testing-library/react"
import manifest from "../plugin.json"
import {
  REFERENCE_SURFACE_IDS,
  ReferenceComposerAction,
  referenceTreeProvider,
  selectionReferenceActions,
} from "./index"

describe("ui-surface-reference", () => {
  it("declares every UI contribution family without hand-written activation events", () => {
    expect(manifest).not.toHaveProperty("activationEvents")
    for (const field of [
      "extensions",
      "contextPanels",
      "viewsContainers",
      "views",
      "webviews",
      "modalMounts",
      "messageRenderers",
      "toolRenderers",
      "quickActions",
      "trayItems",
      "configComponent",
    ]) {
      expect(manifest).toHaveProperty(field)
    }
    expect(REFERENCE_SURFACE_IDS).toContain("view-container")
    expect(REFERENCE_SURFACE_IDS).toHaveLength(13)
  })

  it("renders a styled reference extension and exports a tree provider", async () => {
    render(
      <ReferenceComposerAction
        pluginId="ui-surface-reference"
        extensionId="reference"
        formFactor="icon"
      />
    )

    expect(screen.getByText("composer-action")).toHaveClass("ref-badge")
    await expect(Promise.resolve(referenceTreeProvider.getChildren())).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "tree-view" })])
    )
  })

  it("covers every selection input/output shape with explicit text permission", async () => {
    expect(manifest.permissions).toContain("selection:read")
    expect(selectionReferenceActions.map((action) => action.selection?.output)).toEqual([
      "status",
      "status",
      "preview",
      "copy",
      "replace",
    ])
    expect(selectionReferenceActions[0].selection?.input).toBe("metadata")
    expect(
      selectionReferenceActions.slice(1).every((action) => action.selection?.input === "text")
    ).toBe(true)
    await expect(
      selectionReferenceActions[0].run?.({
        surface: "selection",
        selection: {
          candidateId: "c1",
          sourceApp: "TextEdit",
          origin: "accessibility",
          capturedAt: 1,
          truncated: false,
          contentTypes: [],
          editable: true,
          replaceCapability: "paste",
        },
      })
    ).resolves.toEqual({ kind: "status", message: "TextEdit" })
  })
})
