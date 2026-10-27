//! Deterministic, byte-preserving line provenance, independent of filesystem IO.
//!
//! Unlike ledger's `git diff --no-index`, carry-forward runs in process: spawning
//! Git and writing two scratch files on every observation is unnecessary IO and
//! Git's LF-only line model cannot represent lone CR terminators. We use patience
//! diff with common-prefix/suffix trimming and unique-line LIS anchors. Anchorless
//! interiors conservatively become delete/insert (not a claim of a minimal edit
//! script). An explicit work stack avoids recursion on adversarial files. Sorted
//! maps and leftmost LIS tie breaking make results independent of hash seeds.
//! Repeated-text attribution is explicitly weaker than unique-line attribution.

use std::{collections::BTreeMap, ops::Range};

use serde::{Deserialize, Serialize};

use crate::provenance::MappingEvidence;

/// Maximum raw bytes in one observed content version (2 MiB).
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Maximum logical lines in one observed text version.
pub const MAX_TEXT_LINES: usize = 100_000;

/// A failure that never silently truncates a map or input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LineMapError {
    /// An input exceeds a declared capacity limit.
    #[error("line provenance capacity exceeded: {resource} ({actual} > {limit})")]
    Capacity {
        resource: &'static str,
        actual: usize,
        limit: usize,
    },
    /// Segment coverage or a diff operation sequence is invalid.
    #[error("invalid line map: {0}")]
    InvalidMap(String),
    /// A selected patch cannot be verified against its baseline.
    #[error("invalid selected hunk: {0}")]
    InvalidPatch(String),
}

/// One contiguous half-open, 1-based range with a common source and confidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// First included logical line.
    pub start_line: usize,
    /// First excluded logical line.
    pub end_line: usize,
    /// Durable source identifier, including an explicit source for unknown lines.
    pub provenance_id: String,
    /// Confidence in this source-to-current-line mapping.
    pub mapping_evidence: MappingEvidence,
}

/// A contiguous edit. Every range is 1-based and end-exclusive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOp {
    /// Byte-identical logical lines in both versions.
    Equal {
        old_range: Range<usize>,
        new_range: Range<usize>,
        /// Multiple text matches make the chosen correspondence uncertain.
        ambiguous: bool,
    },
    /// Lines removed from the old version.
    Delete { old_range: Range<usize> },
    /// Lines introduced in the new version.
    Insert { new_range: Range<usize> },
}

/// Complete current map; binary content uses a single whole-file unit at 1..2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMap {
    /// Normalized run-length encoded origins.
    pub segments: Vec<Segment>,
    /// Number of logical text lines, or one whole-file binary unit.
    pub line_count: usize,
    /// True for NUL-containing or invalid UTF-8 content; no text-line claim.
    pub binary: bool,
}

/// Inspect capacity and representation without altering original bytes.
pub fn inspect_content(bytes: &[u8]) -> Result<(usize, bool), LineMapError> {
    let lines = split_lines(bytes)?;
    Ok((lines.len(), is_binary(bytes)))
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

/// Split LF, CRLF and lone CR while retaining every terminator. Empty input has
/// zero lines; invalid UTF-8 or NUL content has one opaque whole-file unit.
pub fn split_lines(bytes: &[u8]) -> Result<Vec<&[u8]>, LineMapError> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(LineMapError::Capacity {
            resource: "bytes",
            actual: bytes.len(),
            limit: MAX_TEXT_BYTES,
        });
    }
    if is_binary(bytes) {
        return Ok(vec![bytes]);
    }
    let mut lines = Vec::new();
    let (mut start, mut index) = (0, 0);
    while index < bytes.len() {
        if bytes[index] == b'\r' || bytes[index] == b'\n' {
            if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            lines.push(&bytes[start..index + 1]);
            start = index + 1;
        }
        index += 1;
    }
    if start < bytes.len() {
        lines.push(&bytes[start..]);
    }
    if lines.len() > MAX_TEXT_LINES {
        return Err(LineMapError::Capacity {
            resource: "lines",
            actual: lines.len(),
            limit: MAX_TEXT_LINES,
        });
    }
    Ok(lines)
}

/// Produce a deterministic edit script. Capacity errors are explicit rather than
/// hidden behind a truncated `Vec`; callers must retain their last good map.
pub fn diff_lines(old: &[u8], new: &[u8]) -> Result<Vec<LineOp>, LineMapError> {
    Ok(diff_slices(&split_lines(old)?, &split_lines(new)?))
}

fn diff_slices(old: &[&[u8]], new: &[&[u8]]) -> Vec<LineOp> {
    let old_occ = occurrences(old);
    let new_occ = occurrences(new);
    let unchanged = old == new;
    let mut equal = Vec::new();
    let mut pending = vec![(0, old.len(), 0, new.len())];
    while let Some((mut a, mut ae, mut b, mut be)) = pending.pop() {
        while a < ae && b < be && old[a] == new[b] {
            equal.push((a, b));
            a += 1;
            b += 1;
        }
        while a < ae && b < be && old[ae - 1] == new[be - 1] {
            ae -= 1;
            be -= 1;
            equal.push((ae, be));
        }
        if a == ae || b == be {
            continue;
        }
        let mut occurrences: BTreeMap<&[u8], (usize, usize, usize, usize)> = BTreeMap::new();
        for (i, line) in old.iter().enumerate().take(ae).skip(a) {
            let entry = occurrences.entry(line).or_default();
            entry.0 += 1;
            entry.1 = i;
        }
        for (i, line) in new.iter().enumerate().take(be).skip(b) {
            let entry = occurrences.entry(line).or_default();
            entry.2 += 1;
            entry.3 = i;
        }
        let mut pairs: Vec<_> = occurrences
            .values()
            .filter(|x| x.0 == 1 && x.2 == 1)
            .map(|x| (x.1, x.3))
            .collect();
        pairs.sort_unstable();
        let mut tails: Vec<usize> = Vec::new();
        let mut previous = vec![None; pairs.len()];
        for (i, &(_, target)) in pairs.iter().enumerate() {
            let slot = tails.partition_point(|&tail| pairs[tail].1 < target);
            if slot > 0 {
                previous[i] = Some(tails[slot - 1]);
            }
            if slot == tails.len() {
                tails.push(i);
            } else {
                tails[slot] = i;
            }
        }
        let mut anchors = Vec::new();
        let mut cursor = tails.last().copied();
        while let Some(i) = cursor {
            anchors.push(pairs[i]);
            cursor = previous[i];
        }
        anchors.reverse();
        let has_anchors = !anchors.is_empty();
        for (x, y) in anchors {
            pending.push((a, x, b, y));
            equal.push((x, y));
            a = x + 1;
            b = y + 1;
        }
        // No unique anchors means this interior is deliberately a replacement.
        if has_anchors && (a < ae || b < be) {
            pending.push((a, ae, b, be));
        }
    }
    equal.sort_unstable();
    let (mut a, mut b) = (0, 0);
    let mut ops = Vec::new();
    for (x, y) in equal {
        let ambiguous = !unchanged && (old_occ[old[x]].len() > 1 || new_occ[new[y]].len() > 1);
        if a < x {
            ops.push(LineOp::Delete {
                old_range: a + 1..x + 1,
            });
        }
        if b < y {
            ops.push(LineOp::Insert {
                new_range: b + 1..y + 1,
            });
        }
        match ops.last_mut() {
            Some(LineOp::Equal {
                old_range,
                new_range,
                ambiguous: previous_ambiguity,
            }) if old_range.end == x + 1 && new_range.end == y + 1 && *previous_ambiguity == ambiguous => {
                old_range.end += 1;
                new_range.end += 1;
            }
            _ => ops.push(LineOp::Equal {
                old_range: x + 1..x + 2,
                new_range: y + 1..y + 2,
                ambiguous,
            }),
        }
        a = x + 1;
        b = y + 1;
    }
    if a < old.len() {
        ops.push(LineOp::Delete {
            old_range: a + 1..old.len() + 1,
        });
    }
    if b < new.len() {
        ops.push(LineOp::Insert {
            new_range: b + 1..new.len() + 1,
        });
    }
    ops
}

/// Validate exact coverage, nonempty identifiers/ranges, capacity, and canonical
/// merging. Empty content must have no segments.
pub fn validate_segments(segments: &[Segment], line_count: usize) -> Result<(), LineMapError> {
    if line_count > MAX_TEXT_LINES {
        return Err(LineMapError::Capacity {
            resource: "lines",
            actual: line_count,
            limit: MAX_TEXT_LINES,
        });
    }
    let mut next = 1;
    let mut previous: Option<&Segment> = None;
    for segment in segments {
        if segment.start_line != next
            || segment.end_line <= segment.start_line
            || segment.end_line > line_count + 1
            || segment.provenance_id.is_empty()
        {
            return Err(LineMapError::InvalidMap(
                "segments must cover each line exactly once".into(),
            ));
        }
        if previous.is_some_and(|last| {
            last.provenance_id == segment.provenance_id
                && last.mapping_evidence == segment.mapping_evidence
        }) {
            return Err(LineMapError::InvalidMap(
                "adjacent equal segments must be merged".into(),
            ));
        }
        next = segment.end_line;
        previous = Some(segment);
    }
    if next != line_count + 1 {
        return Err(LineMapError::InvalidMap(
            "incomplete segment coverage".into(),
        ));
    }
    Ok(())
}

fn append_segment(output: &mut Vec<Segment>, segment: Segment) {
    if let Some(last) = output.last_mut() {
        if last.end_line == segment.start_line
            && last.provenance_id == segment.provenance_id
            && last.mapping_evidence == segment.mapping_evidence
        {
            last.end_line = segment.end_line;
            return;
        }
    }
    output.push(segment);
}

fn carried(evidence: MappingEvidence) -> MappingEvidence {
    match evidence {
        MappingEvidence::Exact | MappingEvidence::Carried => MappingEvidence::Carried,
        other => other,
    }
}

/// Carry unchanged origins, remove deletions and obtain inserted origins from the
/// caller. The operation stream must consume both versions in order, without gaps.
pub fn carry_forward(
    old_segments: &[Segment],
    ops: &[LineOp],
    mut new_origin_for_inserted: impl FnMut(Range<usize>) -> (String, MappingEvidence),
) -> Result<Vec<Segment>, LineMapError> {
    let old_count = old_segments
        .last()
        .map_or(0, |s| s.end_line.saturating_sub(1));
    validate_segments(old_segments, old_count)?;
    let (mut old_cursor, mut new_cursor) = (1, 1);
    let mut output = Vec::new();
    for op in ops {
        let new_end = match op {
            LineOp::Equal { new_range, .. } | LineOp::Insert { new_range } => new_range.end,
            LineOp::Delete { .. } => new_cursor,
        };
        if new_end > MAX_TEXT_LINES + 1 {
            return Err(LineMapError::Capacity {
                resource: "lines",
                actual: new_end - 1,
                limit: MAX_TEXT_LINES,
            });
        }
        let valid = match op {
            LineOp::Equal {
                old_range,
                new_range,
                ..
            } => {
                old_range.start == old_cursor
                    && new_range.start == new_cursor
                    && old_range.end > old_range.start
                    && new_range.end > new_range.start
                    && old_range.len() == new_range.len()
                    && old_range.end <= old_count + 1
                    && new_range.end <= MAX_TEXT_LINES + 1
            }
            LineOp::Delete { old_range } => {
                old_range.start == old_cursor
                    && old_range.end > old_range.start
                    && old_range.end <= old_count + 1
            }
            LineOp::Insert { new_range } => {
                new_range.start == new_cursor
                    && new_range.end > new_range.start
                    && new_range.end <= MAX_TEXT_LINES + 1
            }
        };
        if !valid {
            return Err(LineMapError::InvalidMap(
                "noncontiguous or invalid edit script".into(),
            ));
        }
        match op {
            LineOp::Equal {
                old_range,
                new_range,
                ambiguous
            } => {
                let start = old_segments.partition_point(|s| s.end_line <= old_range.start);
                for source in old_segments[start..]
                    .iter()
                    .take_while(|s| s.start_line < old_range.end)
                {
                    append_segment(
                        &mut output,
                        Segment {
                            start_line: new_range.start + source.start_line.max(old_range.start)
                                - old_range.start,
                            end_line: new_range.start + source.end_line.min(old_range.end)
                                - old_range.start,
                            provenance_id: source.provenance_id.clone(),
                            mapping_evidence: if *ambiguous && source.mapping_evidence != MappingEvidence::Unknown {
                                MappingEvidence::Inferred
                            } else {
                                carried(source.mapping_evidence)
                            },
                        },
                    );
                }
                old_cursor = old_range.end;
                new_cursor = new_range.end;
            }
            LineOp::Delete { old_range } => old_cursor = old_range.end,
            LineOp::Insert { new_range } => {
                let (provenance_id, mapping_evidence) = new_origin_for_inserted(new_range.clone());
                append_segment(
                    &mut output,
                    Segment {
                        start_line: new_range.start,
                        end_line: new_range.end,
                        provenance_id,
                        mapping_evidence,
                    },
                );
                new_cursor = new_range.end;
            }
        }
    }
    if old_cursor != old_count + 1 {
        return Err(LineMapError::InvalidMap(
            "edit script did not consume old version".into(),
        ));
    }
    validate_segments(&output, new_cursor - 1)?;
    Ok(output)
}

struct Hunk {
    start: usize,
    old_count: usize,
    new_count: usize,
    lines: Vec<(u8, Vec<u8>)>,
}

fn parse_hunks(patches: &[&str]) -> Result<Vec<Hunk>, LineMapError> {
    let bad = || LineMapError::InvalidPatch("malformed unified hunk".into());
    let mut hunks: Vec<Hunk> = Vec::new();
    for patch in patches {
        let mut active: Option<Hunk> = None;
        for line in patch.as_bytes().split_inclusive(|&b| b == b'\n') {
            if line.starts_with(b"@@ ") {
                if let Some(hunk) = active.take() {
                    hunks.push(hunk);
                }
                let header = std::str::from_utf8(line).map_err(|_| bad())?;
                let fields: Vec<_> = header.split_whitespace().collect();
                if fields.len() < 4 || fields[3] != "@@" {
                    return Err(bad());
                }
                let parse_range =
                    |value: &str, prefix: char| -> Result<(usize, usize), LineMapError> {
                        let value = value.strip_prefix(prefix).ok_or_else(bad)?;
                        let (start, count) = value.split_once(',').unwrap_or((value, "1"));
                        Ok((
                            start.parse().map_err(|_| bad())?,
                            count.parse().map_err(|_| bad())?,
                        ))
                    };
                let (old_start, old_count) = parse_range(fields[1], '-')?;
                let (new_start, new_count) = parse_range(fields[2], '+')?;
                if (new_count > 0 && new_start == 0) || (new_count == 0 && old_count == 0) {
                    return Err(bad());
                }
                let start = if old_count == 0 {
                    old_start
                } else {
                    old_start.checked_sub(1).ok_or_else(bad)?
                };
                active = Some(Hunk {
                    start,
                    old_count,
                    new_count,
                    lines: Vec::new(),
                });
            } else if let Some(hunk) = active.as_mut() {
                if line == b"\\ No newline at end of file\n"
                    || line == b"\\ No newline at end of file"
                {
                    let (_, previous) = hunk.lines.last_mut().ok_or_else(bad)?;
                    if previous.pop() != Some(b'\n') {
                        return Err(bad());
                    }
                } else if let Some((&kind, content)) = line.split_first() {
                    if matches!(kind, b' ' | b'+' | b'-') {
                        // Unified diff body lines always end in LF; absence of
                        // a content newline is represented by the explicit marker.
                        if !content.ends_with(b"\n") {
                            return Err(bad());
                        }
                        hunk.lines.push((kind, content.to_vec()));
                    } else {
                        return Err(bad());
                    }
                }
            }
        }
        if let Some(hunk) = active {
            hunks.push(hunk);
        }
        if !patch.is_empty() && !patch.contains("@@ ") {
            return Err(bad());
        }
    }
    hunks.sort_by_key(|h| h.start);
    Ok(hunks)
}

fn replay_selected(baseline: &[u8], hunks: &[Hunk]) -> Result<(Vec<u8>, Vec<bool>), LineMapError> {
    // Unified patch coordinates count LF units, even when our provenance model
    // splits lone CR as well. A single Git '+' unit can introduce several
    // logical lines; keep its flag until S has been reconstructed byte-for-byte.
    let baseline: Vec<&[u8]> = baseline.split_inclusive(|&byte| byte == b'\n').collect();
    let mut desired = Vec::new();
    let mut added = Vec::new();
    let mut cursor = 0;
    for hunk in hunks {
        if !hunk
            .lines
            .iter()
            .any(|(kind, _)| matches!(*kind, b'+' | b'-'))
        {
            return Err(LineMapError::InvalidPatch("hunk contains no change".into()));
        }
        if hunk.start < cursor || hunk.start > baseline.len() {
            return Err(LineMapError::InvalidPatch(
                "overlapping or out-of-bounds hunk".into(),
            ));
        }
        for line in &baseline[cursor..hunk.start] {
            desired.push(*line);
            added.push(false);
        }
        cursor = hunk.start;
        let (mut old_count, mut new_count) = (0, 0);
        for (kind, content) in &hunk.lines {
            if *kind != b'+' {
                if baseline.get(cursor).copied() != Some(content.as_slice()) {
                    return Err(LineMapError::InvalidPatch(
                        "hunk does not match baseline bytes".into(),
                    ));
                }
                cursor += 1;
                old_count += 1;
            }
            if *kind != b'-' {
                desired.push(content.as_slice());
                added.push(*kind == b'+');
                new_count += 1;
            }
        }
        if old_count != hunk.old_count || new_count != hunk.new_count {
            return Err(LineMapError::InvalidPatch(
                "hunk line counts disagree with header".into(),
            ));
        }
    }
    for line in &baseline[cursor..] {
        desired.push(*line);
        added.push(false);
    }
    let bytes: usize = desired.iter().map(|line| line.len()).sum();
    if bytes > MAX_TEXT_BYTES {
        return Err(LineMapError::Capacity {
            resource: "bytes",
            actual: bytes,
            limit: MAX_TEXT_BYTES,
        });
    }
    // A missing-newline marker is only legal at the final LF-unit boundary.
    // CR is content to Git, including a trailing CR with a no-newline marker.
    if desired
        .iter()
        .take(desired.len().saturating_sub(1))
        .any(|line| !line.ends_with(b"\n"))
    {
        return Err(LineMapError::InvalidPatch(
            "no-newline marker before the final patch line".into(),
        ));
    }
    let reconstructed = desired.concat();
    let logical = split_lines(&reconstructed)?;
    let mut logical_added = Vec::with_capacity(logical.len());
    let (mut piece, mut used) = (0, 0);
    for line in logical {
        while piece < desired.len() && used == desired[piece].len() {
            piece += 1;
            used = 0;
        }
        logical_added.push(added[piece]);
        used += line.len();
    }
    Ok((reconstructed, logical_added))
}

fn occurrences<'a>(lines: &[&'a [u8]]) -> BTreeMap<&'a [u8], Vec<usize>> {
    let mut result: BTreeMap<&[u8], Vec<usize>> = BTreeMap::new();
    for (index, line) in lines.iter().enumerate() {
        result.entry(line).or_default().push(index);
    }
    result
}

#[cfg(test)]
std::thread_local! {
    // Count provenance aggregation/lookup work, independently of wall-clock
    // scheduling and the diff algorithm's comparisons.
    static ORIGIN_LOOKUP_STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Attribute selected forward unified hunks using B→S→A, preserving C→A origins.
/// Headers' new offsets are intentionally ignored: S is rebuilt from selected
/// hunks in baseline order. Only verified `+` lines can acquire `agent_id`.
/// Ambiguous repeated text is inferred; unproved additions use `unknown_id`.
/// Binary transitions retain a whole-file source only if bytes are unchanged;
/// otherwise they are unknown because text hunks cannot prove binary authorship.
pub fn map_selected_hunks(
    baseline: &[u8],
    selected_patches: &[&str],
    current: &[u8],
    actual: &[u8],
    current_segments: &[Segment],
    agent_id: &str,
    unknown_id: &str,
) -> Result<LineMap, LineMapError> {
    split_lines(baseline)?;
    let before = split_lines(current)?;
    let after = split_lines(actual)?;
    validate_segments(current_segments, before.len())?;
    if is_binary(baseline) || is_binary(current) || is_binary(actual) {
        let ops = diff_slices(&before, &after);
        let segments = carry_forward(current_segments, &ops, |_| {
            (unknown_id.into(), MappingEvidence::Unknown)
        })?;
        return Ok(LineMap {
            segments,
            line_count: after.len(),
            binary: is_binary(actual),
        });
    }
    let hunks = parse_hunks(selected_patches)?;
    let (desired_bytes, added) = replay_selected(baseline, &hunks)?;
    let desired = split_lines(&desired_bytes)?;
    let desired_occ = occurrences(&desired);
    let after_occ = occurrences(&after);
    let before_occ = occurrences(&before);
    let mut source_at = Vec::with_capacity(before.len());
    for segment in current_segments {
        for _ in segment.start_line..segment.end_line {
            source_at.push(segment);
        }
    }
    // Summarize every distinct current line once. Scanning all duplicate
    // positions for each inserted line makes an anchorless repeated-text move
    // quadratic. None means the text has competing origins and stays unknown.
    let mut before_origins: std::collections::HashMap<&[u8], Option<(&str, MappingEvidence)>> =
        std::collections::HashMap::new();
    for (text, source) in before.iter().zip(&source_at) {
        #[cfg(test)]
        ORIGIN_LOOKUP_STEPS.with(|steps| steps.set(steps.get() + 1));
        let evidence = if source.mapping_evidence == MappingEvidence::Unknown {
            MappingEvidence::Unknown
        } else {
            MappingEvidence::Inferred
        };
        before_origins
            .entry(text)
            .and_modify(|origin| match origin {
                Some((id, existing_evidence)) if *id == source.provenance_id => {
                    if evidence == MappingEvidence::Unknown {
                        *existing_evidence = MappingEvidence::Unknown;
                    }
                }
                _ => *origin = None,
            })
            .or_insert(Some((source.provenance_id.as_str(), evidence)));
    }
    let mut candidate: Vec<Option<usize>> = vec![None; after.len()];
    for op in diff_slices(&desired, &after) {
        if let LineOp::Equal {
            old_range,
            new_range,
            ..
        } = op
        {
            for (old, new) in old_range.zip(new_range) {
                if added[old - 1] {
                    candidate[new - 1] = Some(old - 1);
                }
            }
        }
    }
    let mut output = Vec::new();
    for op in diff_slices(&before, &after) {
        match op {
            LineOp::Delete { .. } => {}
            LineOp::Equal {
                old_range,
                new_range,
                ..
            } => {
                for (old, new) in old_range.zip(new_range) {
                    let source = source_at[old - 1];
                    let duplicate = before_occ[before[old - 1]].len() > 1
                        || after_occ[after[new - 1]].len() > 1;
                    let evidence =
                        if duplicate && source.mapping_evidence != MappingEvidence::Unknown {
                            MappingEvidence::Inferred
                        } else {
                            carried(source.mapping_evidence)
                        };
                    append_segment(
                        &mut output,
                        Segment {
                            start_line: new,
                            end_line: new + 1,
                            provenance_id: source.provenance_id.clone(),
                            mapping_evidence: evidence,
                        },
                    );
                }
            }
            LineOp::Insert { new_range } => {
                for new in new_range {
                    let text = after[new - 1];
                    #[cfg(test)]
                    ORIGIN_LOOKUP_STEPS.with(|steps| steps.set(steps.get() + 1));
                    let (id, evidence) = if let Some(existing) = before_origins.get(text) {
                        // A moved/already-present line must not be stolen by the agent.
                        existing.unwrap_or((unknown_id, MappingEvidence::Unknown))
                    } else if let Some(index) = candidate[new - 1] {
                        let unique =
                            desired_occ[desired[index]].len() == 1 && after_occ[text].len() == 1;
                        (
                            agent_id,
                            if unique {
                                MappingEvidence::Exact
                            } else {
                                MappingEvidence::Inferred
                            },
                        )
                    } else {
                        (unknown_id, MappingEvidence::Unknown)
                    };
                    append_segment(
                        &mut output,
                        Segment {
                            start_line: new,
                            end_line: new + 1,
                            provenance_id: id.into(),
                            mapping_evidence: evidence,
                        },
                    );
                }
            }
        }
    }
    validate_segments(&output, after.len())?;
    Ok(LineMap {
        segments: output,
        line_count: after.len(),
        binary: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(start: usize, end: usize, id: &str, evidence: MappingEvidence) -> Segment {
        Segment {
            start_line: start,
            end_line: end,
            provenance_id: id.into(),
            mapping_evidence: evidence,
        }
    }
    fn origins(bytes: &[u8], id: &str) -> Vec<Segment> {
        let count = split_lines(bytes).unwrap().len();
        if count == 0 {
            vec![]
        } else {
            vec![segment(1, count + 1, id, MappingEvidence::Exact)]
        }
    }
    fn ids(map: &LineMap) -> Vec<&str> {
        map.segments
            .iter()
            .flat_map(|s| (s.start_line..s.end_line).map(|_| s.provenance_id.as_str()))
            .collect()
    }

    #[test]
    fn line_map_duplicate_removal_does_not_confirm_arbitrary_source() {
        let old = [segment(1, 2, "A", MappingEvidence::Exact), segment(2, 3, "B", MappingEvidence::Exact)];
        let ops = diff_lines(b"x\nx\n", b"x\n").unwrap();
        let map = carry_forward(&old, &ops, |_| unreachable!()).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[0].mapping_evidence, MappingEvidence::Inferred);
        assert!(matches!(ops[0], LineOp::Equal { ambiguous: true, .. }));
    }

    #[test]
    fn line_map_split_preserves_all_bytes() {
        assert_eq!(
            split_lines(b"a\r\nb\rc\nd").unwrap(),
            vec![b"a\r\n".as_slice(), b"b\r", b"c\n", b"d"]
        );
        assert_eq!(split_lines(b"\r\n").unwrap(), vec![b"\r\n"]);
        assert!(split_lines(b"").unwrap().is_empty());
        assert_eq!(split_lines(b"a").unwrap(), vec![b"a"]);
    }

    #[test]
    fn line_map_diff_deterministic_and_reconstructs_fixtures() {
        let fixtures: &[(&[u8], &[u8])] = &[
            (b"", b"x\n"),
            (b"x\n", b""),
            (b"a\nb\nc\n", b"z\na\nc\nd"),
            (b"x\nx\ny\nx\n", b"x\ny\nx\nx\n"),
            (b"a\r\nb\rc", b"a\r\nb\rc\n"),
        ];
        for &(old, new) in fixtures {
            let expected = diff_lines(old, new).unwrap();
            for _ in 0..16 {
                assert_eq!(diff_lines(old, new).unwrap(), expected);
            }
            let old_lines = split_lines(old).unwrap();
            let new_lines = split_lines(new).unwrap();
            let mut rebuilt = Vec::new();
            for op in &expected {
                match op {
                    LineOp::Equal {
                        old_range,
                        new_range,
                        ..
                    } => {
                        assert_eq!(old_range.len(), new_range.len());
                        for (a, b) in old_range.clone().zip(new_range.clone()) {
                            assert_eq!(old_lines[a - 1], new_lines[b - 1]);
                            rebuilt.extend_from_slice(old_lines[a - 1]);
                        }
                    }
                    LineOp::Insert { new_range } => {
                        for i in new_range.clone() {
                            rebuilt.extend_from_slice(new_lines[i - 1]);
                        }
                    }
                    LineOp::Delete { .. } => {}
                }
            }
            assert_eq!(rebuilt, new);
            let result = carry_forward(&origins(old, "old"), &expected, |_| {
                ("new".into(), MappingEvidence::Exact)
            })
            .unwrap();
            validate_segments(&result, new_lines.len()).unwrap();
        }
    }

    #[test]
    fn line_map_exhaustive_duplicate_small_scripts_cover_both_versions() {
        let mut samples = Vec::new();
        for length in 0..=4 {
            for bits in 0..(1 << length) {
                let mut bytes = Vec::new();
                for index in 0..length {
                    bytes.extend_from_slice(if bits & (1 << index) == 0 {
                        b"a\n"
                    } else {
                        b"b\n"
                    });
                }
                samples.push(bytes);
            }
        }
        for old in &samples {
            for new in &samples {
                let old_lines = split_lines(old).unwrap();
                let new_lines = split_lines(new).unwrap();
                let ops = diff_lines(old, new).unwrap();
                let mut reconstructed = Vec::new();
                for op in &ops {
                    match op {
                        LineOp::Equal {
                            old_range,
                            new_range,
                            ..
                        } => {
                            for (a, b) in old_range.clone().zip(new_range.clone()) {
                                assert_eq!(old_lines[a - 1], new_lines[b - 1]);
                                reconstructed.extend_from_slice(old_lines[a - 1]);
                            }
                        }
                        LineOp::Insert { new_range } => {
                            for b in new_range.clone() {
                                reconstructed.extend_from_slice(new_lines[b - 1]);
                            }
                        }
                        LineOp::Delete { .. } => {}
                    }
                }
                assert_eq!(&reconstructed, new);
                let map = carry_forward(&origins(old, "human"), &ops, |_| {
                    ("agent".into(), MappingEvidence::Exact)
                })
                .unwrap();
                validate_segments(&map, new_lines.len()).unwrap();
            }
        }
    }

    #[test]
    fn line_map_selected_multiple_hunks_replay_in_baseline_order() {
        let baseline = b"a\nb\nc\nd\n";
        let actual = b"a\nx\nb\nc\ny\nd\n";
        let map = map_selected_hunks(
            baseline,
            &["@@ -3 +4,2 @@\n c\n+y\n", "@@ -1 +1,2 @@\n a\n+x\n"],
            baseline,
            actual,
            &origins(baseline, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(
            ids(&map),
            vec!["human", "agent", "human", "human", "agent", "human"]
        );
    }

    #[test]
    fn line_map_carry_insert_delete_replace_and_merge() {
        let old = b"a\nb\nc\n";
        for new in [
            b"x\na\nb\nc\n".as_slice(),
            b"a\nx\nb\nc\n",
            b"a\nb\nc\nx\n",
            b"",
            b"a\nx\ny\nc\n",
        ] {
            let map = carry_forward(
                &origins(old, "human"),
                &diff_lines(old, new).unwrap(),
                |_| ("agent".into(), MappingEvidence::Exact),
            )
            .unwrap();
            validate_segments(&map, split_lines(new).unwrap().len()).unwrap();
        }
        let map = carry_forward(
            &[segment(1, 2, "same", MappingEvidence::Exact)],
            &[
                LineOp::Equal {
                    old_range: 1..2,
                    new_range: 1..2,
                    ambiguous: false,
                },
                LineOp::Insert { new_range: 2..3 },
            ],
            |_| ("same".into(), MappingEvidence::Carried),
        )
        .unwrap();
        assert_eq!(map, vec![segment(1, 3, "same", MappingEvidence::Carried)]);
        assert!(validate_segments(&[segment(2, 3, "bad", MappingEvidence::Exact)], 2).is_err());
        assert!(carry_forward(&origins(old, "old"), &[], |_| unreachable!()).is_err());
    }

    #[test]
    fn line_map_selection_ignores_unselected_earlier_offset() {
        let base = b"a\nb\nc\nd\n";
        let actual = b"a\nb\nc\nagent\nd\n";
        let map = map_selected_hunks(
            base,
            &["@@ -3,1 +5,2 @@\n c\n+agent\n"],
            base,
            actual,
            &origins(base, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["human", "human", "human", "agent", "human"]);
    }

    #[test]
    fn line_map_selection_preserves_three_way_human_edits() {
        let base = b"a\nb\n";
        let current = b"prefix\na\nb\nsuffix\n";
        let actual = b"prefix\na\nagent\nb\nsuffix\n";
        let map = map_selected_hunks(
            base,
            &["@@ -1,1 +1,2 @@\n a\n+agent\n"],
            current,
            actual,
            &origins(current, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["human", "human", "agent", "human", "human"]);
        assert_eq!(map.segments[1].mapping_evidence, MappingEvidence::Exact);
    }

    #[test]
    fn line_map_git_lf_hunk_offsets_project_to_mixed_cr_logical_lines() {
        // Git sees two LF units; provenance sees four logical lines. The hunk
        // starts at Git line 2, not logical line 2, and its '+' unit has 3 lines.
        let baseline = b"a\rb\nc\rd\n";
        let actual = b"a\rb\nc\ragent\rd\n";
        let patch = "@@ -2 +2 @@\n-c\rd\n+c\ragent\rd\n";
        let map = map_selected_hunks(
            baseline,
            &[patch],
            baseline,
            actual,
            &origins(baseline, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["human", "human", "human", "agent", "human"]);
        assert_eq!(map.segments[1].mapping_evidence, MappingEvidence::Exact);
    }

    #[test]
    fn line_map_git_no_lf_patch_preserves_lone_cr_terminators() {
        let baseline = b"a\rb\r";
        let actual = b"a\ragent\rb\r";
        let patch = "@@ -1 +1 @@\n-a\rb\r\n\\ No newline at end of file\n+a\ragent\rb\r\n\\ No newline at end of file\n";
        let map = map_selected_hunks(
            baseline,
            &[patch],
            baseline,
            actual,
            &origins(baseline, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(map.line_count, 3);
        assert_eq!(ids(&map), vec!["human", "agent", "human"]);
    }

    #[test]
    fn line_map_duplicate_and_already_present_lines_are_conservative() {
        let map = map_selected_hunks(
            b"a\n",
            &["@@ -1,1 +1,3 @@\n a\n+x\n+x\n"],
            b"a\n",
            b"a\nx\nx\n",
            &origins(b"a\n", "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(map.segments[1].mapping_evidence, MappingEvidence::Inferred);
        let current = b"a\nx\n";
        let map = map_selected_hunks(
            b"a\n",
            &["@@ -1,1 +1,2 @@\n a\n+x\n"],
            current,
            current,
            &origins(current, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["human", "human"]);
    }

    #[test]
    fn line_map_pure_deletion_empty_and_no_newline_patch() {
        let map = map_selected_hunks(
            b"a\n",
            &["@@ -1,1 +0,0 @@\n-a\n"],
            b"a\n",
            b"",
            &origins(b"a\n", "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert!(map.segments.is_empty());
        let map = map_selected_hunks(
            b"",
            &["@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n"],
            b"",
            b"x",
            &[],
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["agent"]);
    }

    #[test]
    fn line_map_capacity_and_binary_are_explicit() {
        assert_eq!(inspect_content(b"x\0y").unwrap(), (1, true));
        assert_eq!(inspect_content(&[0xff]).unwrap(), (1, true));
        assert!(matches!(
            split_lines(&vec![b'x'; MAX_TEXT_BYTES + 1]),
            Err(LineMapError::Capacity {
                resource: "bytes",
                ..
            })
        ));
        assert!(matches!(
            split_lines(&vec![b'\n'; MAX_TEXT_LINES + 1]),
            Err(LineMapError::Capacity {
                resource: "lines",
                ..
            })
        ));
        assert_eq!(
            split_lines(&vec![b'\n'; MAX_TEXT_LINES]).unwrap().len(),
            MAX_TEXT_LINES
        );
        let map = map_selected_hunks(
            b"\0old",
            &[],
            b"\0old",
            b"\0new",
            &origins(b"\0old", "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert!(map.binary);
        assert_eq!(map.line_count, 1);
        assert_eq!(ids(&map), vec!["unknown"]);
    }

    #[test]
    fn line_map_invalid_patch_is_not_attributed() {
        assert!(map_selected_hunks(
            b"a\n",
            &["@@ -1 +1 @@\n-wrong\n+agent\n"],
            b"a\n",
            b"agent\n",
            &origins(b"a\n", "human"),
            "agent",
            "unknown"
        )
        .is_err());
        for patch in [
            "@@ -0,0 +0,0 @@\n",
            "@@ -1 +1 @@\n a\n",
            "@@ -1 +0 @@\n-a\n+x\n",
            "@@ -1 +1 @@\n-a\n+x",
            "@@ -1 +1 @@\n-a\n+x\n\\ No newline at end of file extra\n",
            "@@ -1 +1,2 @@\n-a\n+x\n",
            "@@ -1 +1 @@\n-a\n+x\n\\ No newline at end of file\n\\ No newline at end of file\n",
            "@@ -1 +1,2 @@\n-a\n+x\n\\ No newline at end of file\n+y\n",
        ] {
            assert!(
                map_selected_hunks(
                    b"a\n",
                    &[patch],
                    b"a\n",
                    b"x\n",
                    &origins(b"a\n", "human"),
                    "agent",
                    "unknown"
                )
                .is_err(),
                "accepted malformed patch: {patch}"
            );
        }
    }

    #[test]
    fn line_map_repeated_block_move_has_bounded_origin_lookup_work() {
        let half = MAX_TEXT_LINES / 2;
        let current = [b"a\n".repeat(half), b"b\n".repeat(half)].concat();
        let actual = [b"b\n".repeat(half), b"a\n".repeat(half)].concat();
        let sources = vec![
            segment(1, half + 1, "source-a", MappingEvidence::Exact),
            segment(half + 1, MAX_TEXT_LINES + 1, "source-b", MappingEvidence::Carried),
        ];
        ORIGIN_LOOKUP_STEPS.with(|steps| steps.set(0));
        let map = map_selected_hunks(b"", &[], &current, &actual, &sources, "agent", "unknown").unwrap();
        let steps = ORIGIN_LOOKUP_STEPS.with(std::cell::Cell::get);
        assert_eq!(map.line_count, MAX_TEXT_LINES);
        assert_eq!(map.segments, vec![
            segment(1, half + 1, "source-b", MappingEvidence::Inferred),
            segment(half + 1, MAX_TEXT_LINES + 1, "source-a", MappingEvidence::Inferred),
        ]);
        // One aggregation per current line and one lookup per inserted line;
        // each HashMap lookup takes expected constant time.
        assert_eq!(steps, 2 * MAX_TEXT_LINES);
    }

    #[test]
    fn line_map_unanimous_text_origin_keeps_the_weakest_mapping_evidence() {
        let current = b"a\na\nb\nb\n";
        let actual = b"b\nb\na\na\n";
        for evidence in [MappingEvidence::Exact, MappingEvidence::Carried, MappingEvidence::Inferred] {
            for unknown_first in [false, true] {
                let pair = if unknown_first {
                    [MappingEvidence::Unknown, evidence]
                } else {
                    [evidence, MappingEvidence::Unknown]
                };
                let sources = vec![
                    segment(1, 2, "source-a", pair[0]),
                    segment(2, 3, "source-a", pair[1]),
                    segment(3, 4, "source-b", pair[0]),
                    segment(4, 5, "source-b", pair[1]),
                ];
                let map = map_selected_hunks(b"", &[], current, actual, &sources, "agent", "unknown").unwrap();
                assert_eq!(map.segments, vec![
                    segment(1, 3, "source-b", MappingEvidence::Unknown),
                    segment(3, 5, "source-a", MappingEvidence::Unknown),
                ]);
            }
        }
        let sources = vec![
            segment(1, 2, "source-a", MappingEvidence::Exact),
            segment(2, 3, "source-a", MappingEvidence::Inferred),
            segment(3, 4, "source-b", MappingEvidence::Carried),
            segment(4, 5, "source-b", MappingEvidence::Inferred),
        ];
        let map = map_selected_hunks(b"", &[], current, actual, &sources, "agent", "unknown").unwrap();
        assert_eq!(map.segments, vec![
            segment(1, 3, "source-b", MappingEvidence::Inferred),
            segment(3, 5, "source-a", MappingEvidence::Inferred),
        ]);
    }

    #[test]
    fn line_map_anchorless_current_lines_never_become_agent_owned() {
        let current = b"a\nb\na\nb\n";
        let actual = b"b\na\nb\na\n";
        let map = map_selected_hunks(
            b"",
            &["@@ -0,0 +1,4 @@\n+b\n+a\n+b\n+a\n"],
            current,
            actual,
            &origins(current, "human"),
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["human", "human", "human", "human"]);
        assert!(map
            .segments
            .iter()
            .all(|s| s.mapping_evidence == MappingEvidence::Inferred));
        let mixed = vec![
            segment(1, 2, "one", MappingEvidence::Exact),
            segment(2, 3, "two", MappingEvidence::Exact),
            segment(3, 5, "three", MappingEvidence::Exact),
        ];
        let map = map_selected_hunks(
            b"",
            &["@@ -0,0 +1,4 @@\n+b\n+a\n+b\n+a\n"],
            current,
            actual,
            &mixed,
            "agent",
            "unknown",
        )
        .unwrap();
        assert_eq!(ids(&map), vec!["unknown", "unknown", "unknown", "unknown"]);
    }
}
