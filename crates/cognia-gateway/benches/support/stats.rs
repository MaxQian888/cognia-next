use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub median_ms: f64,
    pub mad_ms: f64,
    pub p95_ms: f64,
}

pub fn summarize_ms(samples: &[f64]) -> Distribution {
    assert!(
        !samples.is_empty(),
        "benchmark distributions require samples"
    );
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let median_ms = median(&sorted);
    let mut deviations: Vec<f64> = sorted
        .iter()
        .map(|sample| (sample - median_ms).abs())
        .collect();
    deviations.sort_by(f64::total_cmp);
    let rank = ((sorted.len() as f64) * 0.95).ceil() as usize;
    Distribution {
        median_ms,
        mad_ms: median(&deviations),
        p95_ms: sorted[rank.saturating_sub(1).min(sorted.len() - 1)],
    }
}

fn median(sorted: &[f64]) -> f64 {
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}
