use crate::types::TextItem;

/// Options for searching text items.
pub struct SearchOptions {
    pub phrase: String,
    pub case_sensitive: bool,
}

/// Search text items for phrase matches, returning synthetic merged items.
///
/// Consecutive text items are concatenated and searched. When a phrase spans
/// multiple items, the result is a single merged item with a combined bounding
/// box and the matched text. Font metadata is taken from the first matched item.
pub fn search_items(items: &[TextItem], options: &SearchOptions) -> Vec<TextItem> {
    let mut results = Vec::new();
    // An empty phrase matches nothing. Without this guard, `str::contains("")`
    // is always true, so every item would emit a spurious empty-text match.
    if options.phrase.is_empty() {
        return results;
    }
    let normalize = |s: &str| -> String {
        if options.case_sensitive {
            s.to_string()
        } else {
            s.to_lowercase()
        }
    };
    let q = normalize(&options.phrase);

    // Pre-compute separator between each pair of adjacent items.
    // If two items are on the same line and spatially adjacent, join without a space.
    let mut seps: Vec<&str> = vec![""; items.len()];
    for i in 1..items.len() {
        let prev = &items[i - 1];
        let cur = &items[i];
        let font_size = prev.font_size.or(cur.font_size).unwrap_or(12.0);
        let same_line = (cur.y - prev.y).abs() < font_size * 0.5;
        let gap = cur.x - (prev.x + prev.width);
        seps[i] = if same_line && gap <= font_size * 0.3 {
            ""
        } else {
            " "
        };
    }

    let mut start = 0;
    while start < items.len() {
        let mut combined = String::new();
        let mut found = false;

        for end in start..items.len() {
            if end > start {
                combined.push_str(seps[end]);
            }
            combined.push_str(&items[end].text);

            if normalize(&combined).contains(&q) {
                // Narrow from the left: drop leading items that aren't part of the match
                let mut narrowed = combined.clone();
                let mut s = start;
                while s < end {
                    let skip_len = items[s].text.len() + seps[s + 1].len();
                    let without = &narrowed[skip_len..];
                    if normalize(without).contains(&q) {
                        narrowed = without.to_string();
                        s += 1;
                    } else {
                        break;
                    }
                }

                // Merge bounding boxes of matched items
                let matched = &items[s..=end];
                let x = matched.iter().map(|m| m.x).fold(f32::INFINITY, f32::min);
                let y = matched.iter().map(|m| m.y).fold(f32::INFINITY, f32::min);
                let x2 = matched
                    .iter()
                    .map(|m| m.x + m.width)
                    .fold(f32::NEG_INFINITY, f32::max);
                let y2 = matched
                    .iter()
                    .map(|m| m.y + m.height)
                    .fold(f32::NEG_INFINITY, f32::max);

                results.push(TextItem {
                    text: options.phrase.clone(),
                    x,
                    y,
                    width: x2 - x,
                    height: y2 - y,
                    font_name: matched[0].font_name.clone(),
                    font_size: matched[0].font_size,
                    ..Default::default()
                });

                // Advance past the match to avoid duplicates
                start = end + 1;
                found = true;
                break;
            }

            // Stop expanding if combined text is already much longer than the query
            if combined.len() > q.len() * 2 {
                break;
            }
        }

        if !found {
            start += 1;
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_item(text: &str, x: f32, y: f32, width: f32) -> TextItem {
        TextItem {
            text: text.into(),
            x,
            y,
            width,
            height: 12.0,
            font_name: Some("Arial".into()),
            font_size: Some(12.0),
            ..Default::default()
        }
    }

    #[test]
    fn single_item_match() {
        let items = vec![make_item("hello world", 0.0, 0.0, 80.0)];
        let opts = SearchOptions {
            phrase: "hello world".into(),
            case_sensitive: false,
        };
        let results = search_items(&items, &opts);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "hello world");
    }

    #[test]
    fn multi_item_phrase() {
        // Three items on the same line with gaps large enough to insert spaces
        let items = vec![
            make_item("0°C", 0.0, 0.0, 20.0),
            make_item("to", 30.0, 0.0, 12.0),
            make_item("70°C", 52.0, 0.0, 24.0),
        ];
        let opts = SearchOptions {
            phrase: "0°C to 70°C".into(),
            case_sensitive: false,
        };
        let results = search_items(&items, &opts);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "0°C to 70°C");
        assert_eq!(results[0].x, 0.0);
        assert_eq!(results[0].width, 76.0); // 52 + 24
    }

    #[test]
    fn case_insensitive() {
        let items = vec![make_item("Hello World", 0.0, 0.0, 80.0)];
        let opts = SearchOptions {
            phrase: "hello world".into(),
            case_sensitive: false,
        };
        assert_eq!(search_items(&items, &opts).len(), 1);
    }

    #[test]
    fn case_sensitive_no_match() {
        let items = vec![make_item("Hello World", 0.0, 0.0, 80.0)];
        let opts = SearchOptions {
            phrase: "hello world".into(),
            case_sensitive: true,
        };
        assert_eq!(search_items(&items, &opts).len(), 0);
    }

    #[test]
    fn no_match() {
        let items = vec![make_item("foo bar", 0.0, 0.0, 40.0)];
        let opts = SearchOptions {
            phrase: "baz".into(),
            case_sensitive: false,
        };
        assert_eq!(search_items(&items, &opts).len(), 0);
    }

    #[test]
    fn empty_phrase_matches_nothing() {
        let items = vec![
            make_item("alpha", 0.0, 0.0, 30.0),
            make_item("beta", 0.0, 20.0, 30.0),
            make_item("gamma", 0.0, 40.0, 30.0),
        ];
        let opts = SearchOptions {
            phrase: String::new(),
            case_sensitive: false,
        };
        assert_eq!(search_items(&items, &opts).len(), 0);
    }

    #[test]
    fn multiple_matches() {
        let items = vec![
            make_item("hello", 0.0, 0.0, 30.0),
            make_item("world", 0.0, 20.0, 30.0),
            make_item("hello", 0.0, 40.0, 30.0),
        ];
        let opts = SearchOptions {
            phrase: "hello".into(),
            case_sensitive: false,
        };
        let results = search_items(&items, &opts);
        assert_eq!(results.len(), 2);
    }
}
