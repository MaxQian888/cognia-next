//! Shared E2B Connect framing (also used by managed desktops).
#[allow(unused_imports)]
pub(super) use cognia_e2b::connect::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_framing_remains_available_to_pool() {
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&encode_envelope(b"{}"));
        assert!(matches!(
            decoder.next_frame().unwrap(),
            Some(Frame::Message(_))
        ));
    }
}
