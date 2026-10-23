use std::collections::HashSet;

use crate::types::ProjectedLine;

/// Roughly one indent step in PDF points. Used to bucket list items into
/// nesting levels relative to the first item of the list.
pub(super) const LIST_INDENT_STEP_PT: f32 = 12.0;

/// Characters recognized as bullet markers when followed by whitespace.
/// Limited to glyphs that are unlikely to appear at line-start in normal prose.
/// `\u{f0b7}` is the Symbol-font bullet (0xB7) that Word/Adobe emit into the
/// Private Use Area; it isn't remapped to `•` during extraction, so recognize
/// it here rather than let it read as an undecodable label.
const BULLET_CHARS: &[char] = &['•', '·', '◦', '▪', '▸', '▶', '●', '○', '■', '□', '\u{f0b7}'];

/// Detect a list marker at the start of `text`. Returns `(ordered, marker_str,
/// remainder)` when matched; otherwise `None`.
///
/// Recognizes:
/// - Unicode bullet characters (`BULLET_CHARS`) followed by whitespace.
/// - Decimal-prefix markers like `1.` / `1)` / `12.` / `12)` followed by
///   whitespace — kept strict (digits only) so things like footnote callers
///   (`1` alone) and section refs (`A.1`) don't match.
pub(super) fn parse_list_marker(text: &str) -> Option<(bool, String, &str)> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }

    let mut chars = trimmed.chars();
    let first = chars.next()?;

    // Unicode bullet
    if BULLET_CHARS.contains(&first) {
        let rest = chars.as_str();
        if let Some(rest_trim) = rest.strip_prefix(|c: char| c.is_whitespace()) {
            return Some((false, first.to_string(), rest_trim.trim_start()));
        }
    }

    // Decimal: 1. / 1) / 12. / 12)
    if first.is_ascii_digit() {
        let mut digit_end = 1;
        for c in trimmed[1..].chars() {
            if c.is_ascii_digit() {
                digit_end += c.len_utf8();
            } else {
                break;
            }
        }
        // Cap to keep us from matching page-number-like prefixes
        if digit_end <= 3 {
            let after_digits = &trimmed[digit_end..];
            let mut after_iter = after_digits.chars();
            if let Some(punct) = after_iter.next()
                && (punct == '.' || punct == ')')
            {
                let after_punct = after_iter.as_str();
                if let Some(rest_trim) = after_punct.strip_prefix(|c: char| c.is_whitespace()) {
                    let marker = format!("{}{}", &trimmed[..digit_end], punct);
                    return Some((true, marker, rest_trim.trim_start()));
                }
            }
        }
    }

    None
}

// ── Lettered / roman ordered-list detection ───────────────────────────────
//
// `parse_list_marker` deliberately ignores alphabetic (`a.`) and roman (`i.`)
// markers because a single one is indistinguishable from an initial
// ("J. Smith") or a section letter ("A. Background"). The disambiguating
// signal is *sequence*: a real lettered/roman list has consecutive siblings
// (`a, b, c` / `i, ii, iii`) starting at value 1, at a consistent indent.
// `detect_ordered_list_lines` does a region-wide pre-pass to find those runs;
// only their member lines are then treated as list items by the classifier.

/// Marker family. Case is tracked so an `a, b, c` run doesn't absorb an
/// unrelated `A.` and vice-versa.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkerKind {
    AlphaLower,
    AlphaUpper,
    RomanLower,
    RomanUpper,
}

/// Max line-index gap between consecutive members of one run. A list item may
/// wrap over a few body lines, but a marker sitting dozens of lines below its
/// predecessor belongs to different content — don't chain across it.
const ORDERED_RUN_MAX_LINE_GAP: usize = 12;
/// Indent tolerance for members of one run (same as the description-list
/// track tolerance — sub-point jitter from projection).
const ORDERED_RUN_INDENT_TOL_PT: f32 = 8.0;

/// Value of a lowercase roman-numeral string, or `None` if not a valid roman
/// numeral. Case-normalize before calling.
fn roman_value(s: &str) -> Option<u32> {
    if s.is_empty() {
        return None;
    }
    let mut total: i64 = 0;
    let mut prev: i64 = 0;
    for c in s.chars().rev() {
        let v: i64 = match c {
            'i' => 1,
            'v' => 5,
            'x' => 10,
            'l' => 50,
            'c' => 100,
            'd' => 500,
            'm' => 1000,
            _ => return None,
        };
        if v < prev {
            total -= v;
        } else {
            total += v;
            prev = v;
        }
    }
    if total > 0 { Some(total as u32) } else { None }
}

/// Possible `(kind, value)` interpretations of a marker body. A single letter
/// like `i` is ambiguous — both alpha (9th letter) and roman (1) — so both are
/// returned and the sequencer picks whichever continues a run.
fn marker_interpretations(body: &str) -> Vec<(MarkerKind, u32)> {
    let mut out = Vec::new();
    let chars: Vec<char> = body.chars().collect();
    if chars.len() == 1 && chars[0].is_ascii_alphabetic() {
        let c = chars[0];
        if c.is_ascii_lowercase() {
            out.push((MarkerKind::AlphaLower, (c as u32) - ('a' as u32) + 1));
            if let Some(v) = roman_value(&c.to_string()) {
                out.push((MarkerKind::RomanLower, v));
            }
        } else {
            out.push((MarkerKind::AlphaUpper, (c as u32) - ('A' as u32) + 1));
            if let Some(v) = roman_value(&c.to_ascii_lowercase().to_string()) {
                out.push((MarkerKind::RomanUpper, v));
            }
        }
        return out;
    }
    // Multi-char: only roman numerals qualify (real lists don't use "ab.").
    if chars.iter().all(|c| c.is_ascii_lowercase()) {
        if let Some(v) = roman_value(body) {
            out.push((MarkerKind::RomanLower, v));
        }
    } else if chars.iter().all(|c| c.is_ascii_uppercase())
        && let Some(v) = roman_value(&body.to_ascii_lowercase())
    {
        out.push((MarkerKind::RomanUpper, v));
    }
    out
}

/// Split a leading ordered-marker token (`a.`, `iv)`, `(a)`) off `text`,
/// returning `(body, marker, rest)` where `body` is the inner letters, `marker`
/// is the full token as written, and `rest` is the trimmed remainder. Requires
/// whitespace after the marker and a non-empty remainder. Does *not* validate
/// that `body` is a real letter/roman marker — the caller does that via
/// `marker_interpretations`.
fn split_ordered_marker(text: &str) -> Option<(&str, String, &str)> {
    let t = text.trim_start();
    let chars: Vec<char> = t.chars().collect();
    if chars.is_empty() {
        return None;
    }
    // Paren-wrapped: "(a)" / "(iv)"
    if chars[0] == '(' {
        let close = chars.iter().position(|&c| c == ')')?;
        if close < 2 {
            return None; // "()"
        }
        let body_len: usize = chars[1..close].iter().map(|c| c.len_utf8()).sum();
        let after_paren = &t[1 + body_len + 1..];
        let rest = after_paren.strip_prefix(|c: char| c.is_whitespace())?;
        let rest = rest.trim_start();
        if rest.is_empty() {
            return None;
        }
        let body = &t[1..1 + body_len];
        let marker = format!("({body})");
        return Some((body, marker, rest));
    }
    // Suffix form: letters followed by '.' or ')'
    let letter_chars = chars.iter().take_while(|c| c.is_ascii_alphabetic()).count();
    if letter_chars == 0 || letter_chars > 7 {
        return None;
    }
    let body_len: usize = chars[..letter_chars].iter().map(|c| c.len_utf8()).sum();
    let punct = chars.get(letter_chars).copied()?;
    if punct != '.' && punct != ')' {
        return None;
    }
    let after_punct = &t[body_len + punct.len_utf8()..];
    let rest = after_punct.strip_prefix(|c: char| c.is_whitespace())?;
    let rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    let body = &t[..body_len];
    let marker = format!("{body}{punct}");
    Some((body, marker, rest))
}

/// A candidate marker line, in region-local index order.
struct OrderedCandidate {
    idx: usize,
    indent: f32,
    interps: Vec<(MarkerKind, u32)>,
}

/// An in-progress run of sequential markers sharing kind + indent.
struct OrderedRun {
    kind: MarkerKind,
    next: u32,
    indent: f32,
    last_idx: usize,
    members: Vec<usize>,
}

/// Region-wide pre-pass: return the set of line indices whose leading
/// alphabetic / roman marker belongs to a confirmed ordered-list run (≥2
/// sequential siblings starting at value 1, consistent indent, no large
/// document-order gap). Callers treat those lines as ordered list items;
/// unconfirmed one-off markers (initials, lone section letters) are left alone.
pub(super) fn detect_ordered_list_lines(
    lines: &[ProjectedLine],
    table_covered: &HashSet<usize>,
) -> HashSet<usize> {
    let candidates: Vec<OrderedCandidate> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            if table_covered.contains(&i) {
                return None;
            }
            let (body, _marker, _rest) = split_ordered_marker(l.text.trim())?;
            let interps = marker_interpretations(body);
            if interps.is_empty() {
                None
            } else {
                Some(OrderedCandidate {
                    idx: i,
                    indent: l.indent_x,
                    interps,
                })
            }
        })
        .collect();

    let mut runs: Vec<OrderedRun> = Vec::new();
    for c in &candidates {
        // Prefer extending the most recently touched matching run (keeps nested
        // levels — an inner `i.` opens its own run while the outer `a,b,c` run
        // stays open at its own indent).
        let mut extended = false;
        for run in runs.iter_mut().rev() {
            if c.idx - run.last_idx <= ORDERED_RUN_MAX_LINE_GAP
                && (run.indent - c.indent).abs() <= ORDERED_RUN_INDENT_TOL_PT
                && c.interps
                    .iter()
                    .any(|(k, v)| *k == run.kind && *v == run.next)
            {
                run.members.push(c.idx);
                run.next += 1;
                run.last_idx = c.idx;
                extended = true;
                break;
            }
        }
        if extended {
            continue;
        }
        // Start a new run only at the first item of a sequence (value 1):
        // `a`, `A`, `i`, `I`. This is what keeps stray `J.` / `A.` out.
        if let Some(&(kind, _)) = c.interps.iter().find(|(_, v)| *v == 1) {
            runs.push(OrderedRun {
                kind,
                next: 2,
                indent: c.indent,
                last_idx: c.idx,
                members: vec![c.idx],
            });
        }
    }

    let mut confirmed = HashSet::new();
    for run in runs {
        if run.members.len() >= 2 {
            confirmed.extend(run.members);
        }
    }
    confirmed
}

/// For a line already confirmed as an ordered-list member by
/// `detect_ordered_list_lines`, extract `(marker, rest)` for emission.
pub(super) fn split_ordered_marker_for_emit(text: &str) -> Option<(String, String)> {
    let (_body, marker, rest) = split_ordered_marker(text)?;
    Some((marker, rest.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_list_marker_bullets() {
        let (ordered, marker, rest) = parse_list_marker("• item one").unwrap();
        assert!(!ordered);
        assert_eq!(marker, "•");
        assert_eq!(rest, "item one");
    }

    #[test]
    fn parse_list_marker_decimal() {
        let (ordered, marker, rest) = parse_list_marker("1. first").unwrap();
        assert!(ordered);
        assert_eq!(marker, "1.");
        assert_eq!(rest, "first");

        let (ordered, marker, rest) = parse_list_marker("12) twelfth").unwrap();
        assert!(ordered);
        assert_eq!(marker, "12)");
        assert_eq!(rest, "twelfth");
    }

    #[test]
    fn parse_list_marker_rejects_prose() {
        assert!(parse_list_marker("This sentence.").is_none());
        // Bare digit with no terminator → not a list
        assert!(parse_list_marker("2023 was a year").is_none());
        // Footnote caller / page number style — no whitespace after
        assert!(parse_list_marker("1.5x growth").is_none());
    }

    fn ll(text: &str, x: f32, y: f32) -> ProjectedLine {
        super::super::test_helpers::line(text, x, y, 11.0, 10.0)
    }

    #[test]
    fn roman_value_parses() {
        assert_eq!(roman_value("i"), Some(1));
        assert_eq!(roman_value("iv"), Some(4));
        assert_eq!(roman_value("ix"), Some(9));
        assert_eq!(roman_value("xiv"), Some(14));
        assert_eq!(roman_value("q"), None);
    }

    #[test]
    fn split_ordered_marker_forms() {
        assert_eq!(
            split_ordered_marker("a. hello"),
            Some(("a", "a.".to_string(), "hello"))
        );
        assert_eq!(
            split_ordered_marker("iv) hello"),
            Some(("iv", "iv)".to_string(), "hello"))
        );
        assert_eq!(
            split_ordered_marker("(a) hello"),
            Some(("a", "(a)".to_string(), "hello"))
        );
        // No space after marker → not a marker ("i.e." must not split).
        assert!(split_ordered_marker("i.e. therefore").is_none());
        // No remainder.
        assert!(split_ordered_marker("a.").is_none());
    }

    #[test]
    fn detects_lettered_and_roman_sequences() {
        // a./b./c. at one indent, i./ii./iii. deeper — both confirmed.
        let lines = vec![
            ll("a. first item", 20.0, 100.0),
            ll("b. second item", 20.0, 120.0),
            ll("c. third item", 20.0, 140.0),
            ll("i. sub one", 40.0, 160.0),
            ll("ii. sub two", 40.0, 180.0),
            ll("iii. sub three", 40.0, 200.0),
        ];
        let got = detect_ordered_list_lines(&lines, &HashSet::new());
        assert_eq!(got.len(), 6, "all six markers should be confirmed");
        assert!((0..6).all(|i| got.contains(&i)));
    }

    #[test]
    fn lone_marker_is_not_a_list() {
        // A single "A. Background" heading letter has no sibling → not a list.
        let lines = vec![
            ll("A. Background", 20.0, 100.0),
            ll(
                "Some prose about the background of the matter at hand.",
                20.0,
                120.0,
            ),
        ];
        assert!(detect_ordered_list_lines(&lines, &HashSet::new()).is_empty());
    }

    #[test]
    fn initials_are_not_a_list() {
        // "J. Smith" / "M. Jones" are initials, not sequential markers (J=10,
        // M=13, neither starts a run and they aren't consecutive).
        let lines = vec![
            ll(
                "J. Smith reported the findings to the committee.",
                20.0,
                100.0,
            ),
            ll(
                "M. Jones seconded the motion without objection.",
                20.0,
                120.0,
            ),
        ];
        assert!(detect_ordered_list_lines(&lines, &HashSet::new()).is_empty());
    }

    #[test]
    fn does_not_chain_across_large_gaps() {
        // "a." then "b." tens of lines apart are unrelated, not a 2-item list.
        let mut lines = vec![ll("a. opening clause", 20.0, 100.0)];
        for k in 0..14 {
            lines.push(ll(
                "ordinary body prose line here",
                20.0,
                120.0 + k as f32 * 20.0,
            ));
        }
        lines.push(ll("b. much later clause", 20.0, 420.0));
        assert!(detect_ordered_list_lines(&lines, &HashSet::new()).is_empty());
    }

    #[test]
    fn table_covered_markers_are_excluded() {
        // Enumerated table footnotes `(a)`, `(b)` inside a detected table must
        // not be pulled out as a list — that would disturb the table.
        let lines = vec![
            ll(
                "(a) first footnote of the table below the divider rule",
                20.0,
                100.0,
            ),
            ll(
                "(b) second footnote of the table below the divider rule",
                20.0,
                120.0,
            ),
        ];
        // Without the guard they'd confirm as a 2-item run…
        assert_eq!(detect_ordered_list_lines(&lines, &HashSet::new()).len(), 2);
        // …but excluding their line indices leaves nothing.
        let covered: HashSet<usize> = [0usize, 1].into_iter().collect();
        assert!(detect_ordered_list_lines(&lines, &covered).is_empty());
    }
}
