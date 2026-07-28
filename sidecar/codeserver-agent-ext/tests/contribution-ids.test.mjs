import assert from "node:assert/strict"
import test from "node:test"

import {
  assertManagedContributionIds,
  collectContributionIds,
  findOccupiedContributionIds,
} from "../src/contribution-ids.mjs"

test("collects stable global ids across declarative contribution families", () => {
  assert.deepEqual(
    collectContributionIds({
      commands: [{ command: "cognia.acme.run" }],
      views: { explorer: [{ id: "cognia.acme.results" }] },
      customEditors: [{ viewType: "cognia.acme.editor" }],
      languageModelTools: [{ name: "cognia.acme.inspect" }],
    }),
    [
      { kind: "command", id: "cognia.acme.run" },
      { kind: "view", id: "cognia.acme.results" },
      { kind: "customEditor", id: "cognia.acme.editor" },
      { kind: "languageModelTool", id: "cognia.acme.inspect" },
    ]
  )
})

test("generation rejects ids outside the plugin namespace and duplicate ids", () => {
  assert.throws(
    () =>
      assertManagedContributionIds("acme", {
        commands: [{ command: "cognia.other.run" }],
      }),
    /IDE_PROXY_ID_OUTSIDE_NAMESPACE/
  )
  assert.throws(
    () =>
      assertManagedContributionIds("acme", {
        commands: [{ command: "cognia.acme.run" }, { command: "cognia.acme.run" }],
      }),
    /IDE_PROXY_ID_DUPLICATE/
  )
})

test("activation reports ids occupied by another extension", () => {
  const vscode = {
    extensions: {
      all: [
        {
          id: "native.other",
          packageJSON: {
            contributes: { commands: [{ command: "cognia.acme.run" }] },
          },
        },
        {
          id: "cognia-managed.proxy-acme",
          packageJSON: {
            contributes: { commands: [{ command: "cognia.acme.run" }] },
          },
        },
      ],
    },
  }
  assert.deepEqual(
    findOccupiedContributionIds(
      vscode,
      { contributions: { commands: [{ command: "cognia.acme.run" }] } },
      "cognia-managed.proxy-acme"
    ),
    [{ kind: "command", id: "cognia.acme.run", extensionId: "native.other" }]
  )
})
