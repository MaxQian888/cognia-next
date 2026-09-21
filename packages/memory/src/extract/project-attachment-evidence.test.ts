import {
  attachmentEvidenceSourceId,
  parseAttachmentEvidenceSourceId,
} from "./project-attachment-evidence"

const source = {
  messageId: "import:message",
  partIndex: 2,
  attachmentId: "file:a",
  contentHash: "sha256:abc",
  segmentId: "page:2",
  locator: '{"type":"page","page":2}',
  start: 0,
  end: 100,
}

it("round-trips opaque ids, structured locators, and exact segment offsets", () => {
  expect(parseAttachmentEvidenceSourceId(attachmentEvidenceSourceId(source))).toEqual(source)
})

it.each([
  "message:2",
  "attachment:broken",
  "attachment:[]",
  'attachment:["m",-1,"a","hash","s","page",0,2]',
  'attachment:["m",0,"a","hash","s","page",2,1]',
])("rejects malformed attachment citations %s", (value) => {
  expect(parseAttachmentEvidenceSourceId(value)).toBeUndefined()
})
