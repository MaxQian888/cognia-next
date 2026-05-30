import { parseMultiStatus } from "./propfind"

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cognia-backups/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Sat, 30 May 2026 12:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cognia-backups/latest.enc.cbk</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>2048</D:getcontentlength>
        <D:getlastmodified>Sat, 30 May 2026 12:30:00 GMT</D:getlastmodified>
        <D:getetag>"abc123"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

describe("parseMultiStatus", () => {
  it("parses collection + file entries", () => {
    const entries = parseMultiStatus(MULTISTATUS)
    expect(entries).toHaveLength(2)

    const collection = entries[0]
    expect(collection.isCollection).toBe(true)
    expect(collection.name).toBe("cognia-backups")
    expect(collection.lastModified).toBe(Date.parse("Sat, 30 May 2026 12:00:00 GMT"))

    const file = entries[1]
    expect(file.isCollection).toBe(false)
    expect(file.name).toBe("latest.enc.cbk")
    expect(file.size).toBe(2048)
    expect(file.etag).toBe("abc123")
    expect(file.lastModified).toBe(Date.parse("Sat, 30 May 2026 12:30:00 GMT"))
  })

  it("handles lowercase / default namespace prefixes", () => {
    const xml = `<?xml version="1.0"?>
      <multistatus xmlns="DAV:">
        <response>
          <href>/dir/file%20one.cbk</href>
          <propstat><prop>
            <getcontentlength>10</getcontentlength>
          </prop></propstat>
        </response>
      </multistatus>`
    const entries = parseMultiStatus(xml)
    expect(entries).toHaveLength(1)
    // href is percent-decoded.
    expect(entries[0].name).toBe("file one.cbk")
    expect(entries[0].size).toBe(10)
    expect(entries[0].lastModified).toBeUndefined()
  })

  it("skips responses without an href", () => {
    const xml = `<multistatus xmlns="DAV:"><response><propstat/></response></multistatus>`
    expect(parseMultiStatus(xml)).toEqual([])
  })

  it("returns empty on malformed XML", () => {
    expect(parseMultiStatus("<<<not xml")).toEqual([])
  })
})
