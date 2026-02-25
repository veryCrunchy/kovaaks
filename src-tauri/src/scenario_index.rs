/// Local scenario name index built from the user's KovaaK's stats directory.
///
/// KovaaK's writes one CSV per session named:
///   `{Scenario Name} - Challenge Start - {YYYY.MM.DD-HH.mm.ss}.csv`
///
/// By scanning those filenames we get a perfect list of scenarios the user has
/// actually played — no network required.  This index is used as the *primary*
/// source for OCR correction: we fuzzy-match the raw OCR text against known
/// names and return the canonical spelling if the similarity is high enough.
///
/// Jaro-Winkler is used because it weights the start of strings more heavily
/// (scenario names often share a common prefix) and is tolerant of single-char
/// substitutions (the main failure mode for OCR "1" ↔ "l" / "I" ↔ "l").
///
/// `ocr_normalize` is applied to *both* the query and the index entry before
/// comparing, so pure confusable errors (1/l/i, 0/o) score as perfect matches
/// even before Jaro-Winkler gets involved.
use std::collections::HashSet;
use std::path::Path;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// The in-memory index.  Populated by `rebuild()`, queried by `fuzzy_match()`.
static INDEX: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

// ─── Public API ───────────────────────────────────────────────────────────────

/// Scan `stats_dir` for CSV files and rebuild the in-memory index.
/// Safe to call repeatedly — replaces the previous index atomically.
pub fn rebuild(stats_dir: &Path) {
    let mut names: HashSet<String> = HashSet::new();

    let entries = match std::fs::read_dir(stats_dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("scenario_index: cannot read stats dir {:?}: {e}", stats_dir);
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("csv") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if let Some(name) = extract_scenario_name(stem) {
                names.insert(name);
            }
        }
    }

    let mut idx = INDEX.lock();
    *idx = names.into_iter().collect();
    idx.sort();
    log::info!(
        "scenario_index: indexed {} unique scenario names from {:?}",
        idx.len(),
        stats_dir
    );
}

/// Returns the number of scenario names currently in the index.
pub fn len() -> usize {
    INDEX.lock().len()
}

/// Find the closest match for an OCR-read scenario name in the local index.
///
/// Returns `Some(canonical_name)` when the best Jaro-Winkler similarity (after
/// applying OCR normalisation to both sides) is ≥ `MATCH_THRESHOLD`.  Returns
/// `None` if the index is empty or no entry scores high enough.
pub fn fuzzy_match(query: &str) -> Option<String> {
    let idx = INDEX.lock();
    if idx.is_empty() {
        return None;
    }

    let q_norm = ocr_normalize(&query.to_lowercase());

    let (best_name, best_score) = idx
        .iter()
        .map(|name| {
            let n_norm = ocr_normalize(&name.to_lowercase());
            let score = strsim::jaro_winkler(&q_norm, &n_norm);
            (name, score)
        })
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))?;

    // Require a high enough similarity to avoid false positives.
    // 0.88 handles 1–2 OCR confusable errors on typical 15–25 char names.
    const MATCH_THRESHOLD: f64 = 0.88;

    if best_score >= MATCH_THRESHOLD {
        log::info!(
            "scenario_index: match {:?} → {:?} (jaro_winkler={:.3})",
            query,
            best_name,
            best_score
        );
        Some(best_name.clone())
    } else {
        log::debug!(
            "scenario_index: no match for {:?} (best {:?} score={:.3})",
            query,
            best_name,
            best_score
        );
        None
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Normalise a string for OCR-tolerant comparison:
///   lowercase + collapse common glyph confusables:
///   • 1 / l / i  → '1'
///   • 0 / o      → '0'
///
/// Applied symmetrically to both the OCR text and the index entry so that purely
/// confusable errors result in a perfect (1.0) Jaro-Winkler score.
pub(crate) fn ocr_normalize(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '1' | 'l' | 'i' => '1',
            '0' | 'o' => '0',
            c => c,
        })
        .collect()
}

/// Extract the scenario name from a KovaaK's stats filename stem.
///   `"Aimlabs Gridshot Easy - Challenge Start - 2024.01.15-12.30.45"`
///   → `Some("Aimlabs Gridshot Easy")`
fn extract_scenario_name(stem: &str) -> Option<String> {
    const MARKER: &str = " - Challenge Start - ";
    stem.find(MARKER)
        .map(|idx| stem[..idx].trim().to_string())
        .filter(|s| !s.is_empty())
}
