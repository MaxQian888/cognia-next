#[path = "../benches/support/stats.rs"]
mod stats;

#[test]
fn distribution_uses_observed_median_mad_and_p95() {
    let distribution = stats::summarize_ms(&[1.0, 2.0, 3.0, 4.0, 100.0]);

    assert_eq!(distribution.median_ms, 3.0);
    assert_eq!(distribution.mad_ms, 1.0);
    assert_eq!(distribution.p95_ms, 100.0);
}
