//! How `cognia-server pair` presents an invitation in a terminal (ADR-0224 A2):
//! the `cgnp…` string, a QR code a phone can scan off the screen, and when the
//! invitation stops working.

use qrcode::render::unicode::Dense1x2;
use qrcode::{EcLevel, QrCode};

/// Render `text` as a QR code made of half-block characters, two modules per
/// character row, with the quiet zone scanners need. Blocks are painted for
/// the *light* modules, so on a dark terminal (the common case, and what
/// `qrencode -t UTF8` assumes) the code reads dark-on-light as cameras
/// expect. The `cgnp…` string is always printed too, for light themes and
/// for pasting.
pub fn render_terminal_qr(text: &str) -> Result<String, String> {
    // Low error correction keeps a relay invitation (a room descriptor and a
    // one-shot key) small enough to fit an ordinary terminal.
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L)
        .map_err(|error| format!("cannot encode the invitation as a QR code: {error}"))?;
    Ok(code
        .render::<Dense1x2>()
        .dark_color(Dense1x2::Light)
        .light_color(Dense1x2::Dark)
        .quiet_zone(true)
        .build())
}

/// `expires at 2026-10-11 01:40:00 UTC (in 5 minutes)`, or that it already
/// expired. Minutes are rounded to the nearest one, so a fresh five-minute
/// invitation reads "5 minutes"; under a minute reads as seconds.
pub fn describe_expiry(expires_at_ms: i64, now_ms: i64) -> String {
    let at = chrono::DateTime::from_timestamp_millis(expires_at_ms)
        .map(|time| time.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .unwrap_or_else(|| format!("{expires_at_ms} (epoch ms)"));
    let left_secs = (expires_at_ms - now_ms) / 1_000;
    if left_secs <= 0 {
        return format!("expired at {at}");
    }
    let left = if left_secs < 60 {
        format!("{left_secs} second{}", if left_secs == 1 { "" } else { "s" })
    } else {
        let minutes = (left_secs + 30) / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    };
    format!("expires at {at} (in {left})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_qr_code_is_square_half_block_art_with_a_quiet_zone() {
        let art = render_terminal_qr("cgnp4|eyJiYXNlIjoiaHR0cHM6Ly8xMjcuMC4wLjE6Mjc4OTAifQ").expect("qr");
        let lines: Vec<&str> = art.lines().collect();
        let width = lines[0].chars().count();
        assert!(lines.iter().all(|line| line.chars().count() == width));
        // Two modules per row: height is half the width, rounded up.
        assert_eq!(lines.len(), width.div_ceil(2));
        // Version 1 is 21 modules; with the 4-module quiet zone on each side.
        assert!(width >= 29);
        // The quiet zone is blank: the first row holds no dark module.
        assert!(lines[0].chars().all(|c| c == lines[0].chars().next().unwrap()));
        assert!(art.chars().all(|c| c == '\n' || matches!(c, ' ' | '█' | '▀' | '▄')));
    }

    #[test]
    fn a_relay_sized_invitation_still_encodes() {
        // A cgnp4 with a room descriptor and a JWK is several hundred bytes.
        let payload = format!("cgnp4|{}", "A".repeat(1_200));
        let art = render_terminal_qr(&payload).expect("fits a QR code");
        assert!(art.lines().count() > 30);
        assert!(render_terminal_qr(&"A".repeat(5_000)).is_err());
    }

    #[test]
    fn expiry_reads_as_a_time_and_how_long_is_left() {
        let now = 1_760_000_000_000;
        assert_eq!(
            describe_expiry(now + 5 * 60_000, now),
            "expires at 2025-10-09 08:58:20 UTC (in 5 minutes)"
        );
        // Issued a second ago: still "5 minutes", not "4".
        assert!(describe_expiry(now + 299_000, now).ends_with("(in 5 minutes)"));
        assert!(describe_expiry(now + 61_000, now).ends_with("(in 1 minute)"));
        assert!(describe_expiry(now + 30_000, now).ends_with("(in 30 seconds)"));
        assert!(describe_expiry(now - 1, now).starts_with("expired at"));
    }
}
