import assert from "node:assert/strict"
import test from "node:test"

import { BEATS, BEAT_FOCUS, DEMO, LOCALES, buildDemoTranscript } from "./demo-transcript.mjs"

for (const locale of LOCALES) {
  test(`${locale}: every stage has a hold and the script opens on the request`, () => {
    const { script, holds } = buildDemoTranscript(locale)
    assert.equal(holds.length, script.stages.length)
    assert.ok(holds.every((ms) => Number.isInteger(ms) && ms > 0))
    assert.equal(script.stages[0].kind, "append")
    assert.equal(script.stages[0].message.role, "user")
  })

  test(`${locale}: beats appear once each, in story order, on real stages`, () => {
    const { script, beats } = buildDemoTranscript(locale)
    assert.deepEqual(
      beats.map((b) => b.beat),
      BEATS
    )
    const stages = beats.map((b) => b.stage)
    assert.deepEqual(
      stages,
      [...stages].sort((a, b) => a - b)
    )
    assert.ok(stages.every((s) => s >= 0 && s < script.stages.length))
  })

  test(`${locale}: every patch and approval names a tool call added earlier`, () => {
    const { script } = buildDemoTranscript(locale)
    const added = new Set()
    for (const stage of script.stages) {
      if (stage.kind === "addPart") added.add(stage.part.toolCallId)
      if (stage.kind === "patchPart" || stage.kind === "approval") {
        assert.ok(added.has(stage.toolCallId), `${stage.kind} before ${stage.toolCallId}`)
      }
    }
  })

  test(`${locale}: every tool call arrives running before it settles`, () => {
    // A card mounts open only while its call is running; one added already
    // settled renders as a collapsed row and the camera sees nothing.
    const { script } = buildDemoTranscript(locale)
    for (const stage of script.stages) {
      if (stage.kind !== "addPart" || !String(stage.part.type).startsWith("tool-")) continue
      assert.ok(
        stage.part.state === "input-available" || stage.part.state === "approval-requested",
        `${stage.part.toolCallId} arrives ${stage.part.state}`
      )
    }
  })

  test(`${locale}: the story fails the check, fixes it, passes it and halts on the push`, () => {
    const { script } = buildDemoTranscript(locale)
    const patches = script.stages.filter((s) => s.kind === "patchPart")
    const failing = patches.find((s) => s.toolCallId === "demo-run-failing")
    const passing = patches.find((s) => s.toolCallId === "demo-run-passing")
    assert.equal(failing.patch.state, "output-error")
    assert.match(failing.patch.errorText, /rounds JPY totals to whole yen/)
    assert.equal(passing.patch.state, "output-available")
    assert.match(passing.patch.output, /3 passed/)
    const last = script.stages.at(-1)
    assert.equal(last.kind, "approval")
    assert.equal(last.input.command, DEMO.pushCommand)
  })
}

test("the two locales tell the same story with different words", () => {
  const en = buildDemoTranscript("en")
  const zh = buildDemoTranscript("zh")
  assert.deepEqual(
    en.script.stages.map((s) => s.kind),
    zh.script.stages.map((s) => s.kind)
  )
  assert.deepEqual(en.holds, zh.holds)
  assert.deepEqual(en.beats, zh.beats)
  assert.notEqual(
    en.script.stages[0].message.parts[0].text,
    zh.script.stages[0].message.parts[0].text
  )
})

test("identities never translate", () => {
  const zh = JSON.stringify(buildDemoTranscript("zh").script)
  for (const value of [DEMO.testCommand, DEMO.sourcePath, DEMO.pushCommand, DEMO.artifact]) {
    assert.ok(zh.includes(value), value)
  }
})

test("an unsupported locale is refused", () => {
  assert.throws(() => buildDemoTranscript("fr"), /unsupported locale fr/)
})

test("every beat names a product element for the camera to frame", () => {
  assert.deepEqual(Object.keys(BEAT_FOCUS), BEATS)
  for (const [beat, { selector, which }] of Object.entries(BEAT_FOCUS)) {
    assert.ok(selector.length > 0, beat)
    assert.ok(which === "first" || which === "last", beat)
  }
})
