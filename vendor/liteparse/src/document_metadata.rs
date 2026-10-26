//! Document-level PDF provenance metadata extraction.

use crate::types::{DocumentMetadata, PdfInput};
use pdfium::Document;
use std::io::{Read, Seek, SeekFrom};

const SCAN_BUFFER_BYTES: usize = 1 << 20;
const SCAN_OVERLAP: usize = 64;
const XMP_MAX_BYTES: usize = 64 * 1024;
/// Above this size, resolving the catalog's `/Metadata` object costs more than
/// the whole parse: lopdf decodes every stream, so a 103 MB file takes ~7.8 s
/// (worst case measured under the cap is ~0.5 s). Larger documents report no
/// `xmp` at all rather than a cheaper guess — the first `<?xpacket` in the raw
/// bytes is frequently an embedded image's packet, not the document's.
#[cfg(not(target_arch = "wasm32"))]
const XMP_CATALOG_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub fn extract(input: &PdfInput, document: &Document<'_>) -> DocumentMetadata {
    let mut metadata = match input {
        #[cfg(not(target_arch = "wasm32"))]
        PdfInput::Path(path) => std::fs::File::open(path)
            .ok()
            .map(|mut file| extract_raw_facts(&mut file))
            .unwrap_or_default(),
        PdfInput::Bytes(bytes) => extract_raw_facts(&mut std::io::Cursor::new(bytes)),
        #[cfg(target_arch = "wasm32")]
        PdfInput::Path(_) => DocumentMetadata::default(),
    };

    // `meta_text` reports an Info key that is present but empty as `Some("")`;
    // the metadata block has always treated that as absent.
    metadata.creation_date = document
        .meta_text("CreationDate")
        .filter(|value| !value.is_empty());
    metadata.mod_date = document
        .meta_text("ModDate")
        .filter(|value| !value.is_empty());
    metadata.file_version = document.file_version();
    let security_revision = document.security_handler_revision();
    metadata.is_encrypted = Some(security_revision != -1);
    if security_revision != -1 {
        metadata.security_handler_revision = Some(security_revision);
        metadata.permissions = Some(document.permissions());
    }
    let signatures = document.signature_summary(metadata.raw_file_size);
    metadata.signature_count = signatures.count;
    metadata.signature_byte_range_reaches_eof = signatures.byte_range_reaches_eof;

    #[cfg(not(target_arch = "wasm32"))]
    if let Some((xmp, truncated)) = catalog_xmp(input, metadata.raw_file_size) {
        metadata.xmp = Some(xmp);
        metadata.xmp_truncated = Some(truncated);
    }
    metadata
}

/// Read the document catalog's `/Metadata` XMP stream — the only XMP that is
/// certainly the document's own. `None` when the file is too large to parse
/// cheaply, has no catalog metadata, or cannot be decoded (encrypted or
/// damaged); the caller then reports no XMP.
#[cfg(not(target_arch = "wasm32"))]
fn catalog_xmp(input: &PdfInput, file_size: Option<u64>) -> Option<(String, bool)> {
    if file_size? > XMP_CATALOG_MAX_FILE_BYTES {
        return None;
    }
    let document = match input {
        PdfInput::Path(path) => lopdf::Document::load(path).ok()?,
        PdfInput::Bytes(bytes) => lopdf::Document::load_mem(bytes).ok()?,
    };
    let object = document.catalog().ok()?.get(b"Metadata").ok()?;
    let stream = document.dereference(object).ok()?.1.as_stream().ok()?;
    let bytes = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());
    let truncated = bytes.len() > XMP_MAX_BYTES;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(XMP_MAX_BYTES)]).into_owned();
    (!text.trim().is_empty()).then_some((text, truncated))
}

fn extract_raw_facts<R: Read + Seek>(reader: &mut R) -> DocumentMetadata {
    let mut metadata = DocumentMetadata::default();
    let file_size = reader.seek(SeekFrom::End(0)).ok();
    metadata.raw_file_size = file_size;
    if reader.seek(SeekFrom::Start(0)).is_err() {
        return metadata;
    }

    let mut buffer = vec![0u8; SCAN_BUFFER_BYTES];
    let mut carry = 0usize;
    let mut eof_count = 0u32;
    let mut startxref_count = 0u32;

    loop {
        // Must be a full fill, not a single `read`: a short read would shrink
        // the window below a marker's length and lose it entirely.
        let got = fill_buffer(reader, &mut buffer[carry..]);
        let window_len = carry + got;
        if window_len == 0 {
            break;
        }
        let countable = if got > 0 && window_len > SCAN_OVERLAP {
            window_len - SCAN_OVERLAP
        } else {
            window_len
        };
        let window = &buffer[..window_len];
        eof_count = eof_count.saturating_add(count_occurrences_before(window, b"%%EOF", countable));
        startxref_count = startxref_count.saturating_add(count_occurrences_before(
            window,
            b"startxref",
            countable,
        ));
        if got == 0 {
            break;
        }
        carry = window_len - countable;
        buffer.copy_within(countable..window_len, 0);
    }

    metadata.eof_section_count = Some(eof_count);
    metadata.startxref_count = Some(startxref_count);

    if let Some(file_size) = file_size {
        let tail_start = file_size.saturating_sub(SCAN_BUFFER_BYTES as u64);
        if reader.seek(SeekFrom::Start(tail_start)).is_ok()
            && let Some(tail) = read_up_to(reader, (file_size - tail_start) as usize)
        {
            metadata.trailer_id_pair_differs = trailer_id_pair_differs(&tail);
        }
    }

    metadata
}

/// Read up to `max` bytes, retrying short reads. `None` when the reader
/// yielded nothing at all.
fn read_up_to<R: Read>(reader: &mut R, max: usize) -> Option<Vec<u8>> {
    let mut buffer = vec![0u8; max];
    let got = fill_buffer(reader, &mut buffer);
    buffer.truncate(got);
    (got > 0).then_some(buffer)
}

/// Fill `buf` completely, looping over short reads. Returns the byte count,
/// short only at EOF or on a read error.
fn fill_buffer<R: Read>(reader: &mut R, buf: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(got) => filled += got,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    filled
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    memchr::memmem::find(haystack, needle)
}

fn count_occurrences_before(haystack: &[u8], needle: &[u8], start_limit: usize) -> u32 {
    memchr::memmem::find_iter(haystack, needle)
        .take_while(|offset| *offset < start_limit)
        .count()
        .min(u32::MAX as usize) as u32
}

fn trailer_id_pair_differs(bytes: &[u8]) -> Option<bool> {
    let mut cursor = 0usize;
    let mut last_pair: Option<(&[u8], &[u8])> = None;
    while let Some(offset) = find_bytes(&bytes[cursor..], b"/ID") {
        let id_start = cursor + offset;
        let mut pos = id_start + 3;
        while bytes
            .get(pos)
            .is_some_and(|b| matches!(b, b' ' | b'\r' | b'\n' | b'\t'))
        {
            pos += 1;
        }
        if bytes.get(pos) == Some(&b'[') {
            pos += 1;
            let mut values = Vec::with_capacity(2);
            while pos < bytes.len() && bytes[pos] != b']' && values.len() < 2 {
                if bytes[pos] == b'<' {
                    let start = pos + 1;
                    if let Some(close) = bytes[start..].iter().position(|b| *b == b'>') {
                        values.push(&bytes[start..start + close]);
                        pos = start + close;
                    }
                }
                pos += 1;
            }
            if values.len() == 2 {
                last_pair = Some((values[0], values[1]));
            }
        }
        cursor = id_start + 3;
    }
    last_pair.map(|(first, second)| first != second)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cognia regression coverage for the lopdf 0.46 security migration.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn cognia_catalog_xmp_reads_bytes_and_paths() {
        use lopdf::{Document, Stream, dictionary};
        let xmp = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">Cognia</x:xmpmeta>";
        let mut document = Document::with_version("1.4");
        let metadata = document.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            xmp.as_bytes().to_vec(),
        ));
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog", "Metadata" => metadata,
        });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let expected = Some((xmp.to_owned(), false));
        let size = Some(bytes.len() as u64);
        assert_eq!(catalog_xmp(&PdfInput::Bytes(bytes.clone()), size), expected);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), bytes).unwrap();
        assert_eq!(
            catalog_xmp(
                &PdfInput::Path(file.path().to_string_lossy().into_owned()),
                size
            ),
            expected
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn cognia_deeply_nested_catalog_does_not_abort() {
        // RUSTSEC-2026-0187: use raw bytes so fixture creation/drop cannot
        // itself recurse. Keep a valid xref so the actual loader is exercised.
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let object_offset = pdf.len();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /X ");
        pdf.extend(std::iter::repeat_n(b'[', 10_380));
        pdf.extend_from_slice(b"0");
        pdf.extend(std::iter::repeat_n(b']', 10_380));
        pdf.extend_from_slice(b" >> endobj\n");
        let xref_offset = pdf.len();
        pdf.extend_from_slice(format!(
            "xref\n0 2\n0000000000 65535 f \n{object_offset:010} 00000 n \ntrailer << /Size 2 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
        ).as_bytes());
        let size = Some(pdf.len() as u64);
        assert_eq!(catalog_xmp(&PdfInput::Bytes(pdf), size), None);
    }

    #[test]
    fn extracts_raw_provenance_facts() {
        let pdf = b"%PDF-1.4\n/ID [<aaaa><bbbb>]\nstartxref\n1\n%%EOF\n\
                    update\n/ID [ <cccc> <dddd> ]\nstartxref\n2\n%%EOF\ntail";
        let metadata = extract_raw_facts(&mut std::io::Cursor::new(pdf));
        assert_eq!(metadata.raw_file_size, Some(pdf.len() as u64));
        assert_eq!(metadata.eof_section_count, Some(2));
        assert_eq!(metadata.startxref_count, Some(2));
        assert_eq!(metadata.trailer_id_pair_differs, Some(true));
        // XMP comes from the catalog only; the raw scan never guesses at it.
        assert_eq!(metadata.xmp, None);
    }

    /// A reader that hands back one byte at a time, like a slow pipe.
    struct DripReader(std::io::Cursor<Vec<u8>>);

    impl Read for DripReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let take = buf.len().min(1);
            self.0.read(&mut buf[..take])
        }
    }

    impl Seek for DripReader {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.0.seek(pos)
        }
    }

    #[test]
    fn short_reads_do_not_lose_markers_or_the_trailer() {
        let pdf = b"%PDF-1.4\nbody\n/ID [<aaaa><bbbb>]\nstartxref\n1\n%%EOF\n";
        let metadata = extract_raw_facts(&mut DripReader(std::io::Cursor::new(pdf.to_vec())));
        assert_eq!(metadata.trailer_id_pair_differs, Some(true));
        assert_eq!(metadata.startxref_count, Some(1));
        assert_eq!(metadata.eof_section_count, Some(1));
    }

    #[test]
    fn trailer_id_uses_last_valid_pair() {
        assert_eq!(
            trailer_id_pair_differs(b"/ID [<aa><bb>] junk /ID [<cc><cc>]"),
            Some(false)
        );
        assert_eq!(trailer_id_pair_differs(b"no trailer id"), None);
    }

    #[test]
    fn finds_markers_that_cross_scan_chunks_without_double_counting() {
        let mut pdf = vec![b'x'; SCAN_BUFFER_BYTES - 7];
        pdf.extend_from_slice(b"startxref\n%%EOF\npayload");
        let metadata = extract_raw_facts(&mut std::io::Cursor::new(pdf));
        assert_eq!(metadata.startxref_count, Some(1));
        assert_eq!(metadata.eof_section_count, Some(1));
    }
}
