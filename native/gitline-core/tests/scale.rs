// The spike's scale targets: a 5,000+ commit history and a 10,000-line diff must load quickly enough
// that the UI only has to draw what's on screen.
mod common;

#[path = "common/big.rs"]
mod big;

use std::time::Instant;

use common::*;
use gitline_core::highlight::ThemeKind;
use gitline_core::view::{DiffView, History, RowKind};
use gitline_core::*;

#[test]
fn loads_a_big_history_and_a_big_diff() {
    let r = tmp_dir();
    big::make_big_repo(&r, 6000, 10_000);

    let t = Instant::now();
    let info = r.info().unwrap();
    let commits = r.log(10_000, &GraphFilter::default()).unwrap();
    let refs = r.refs().unwrap();
    let log_ms = t.elapsed().as_millis();
    assert!(commits.len() > 5000, "{}", commits.len());
    assert!(refs.iter().any(|x| x.name == "v1"));

    let t = Instant::now();
    let head = info.head.as_deref();
    let h = History::build(commits, refs, head, head, true);
    let cells: usize = (0..h.commits.len()).map(|i| h.cell(i, head).lines.len()).sum();
    let graph_ms = t.elapsed().as_millis();
    assert!(h.graph.max_lanes >= 2);
    assert!(cells > h.commits.len());

    let t = Instant::now();
    let text = r.diff_working("big.rs", false, false, None, false).unwrap();
    let diff_ms = t.elapsed().as_millis();
    // The UIs show the plain diff at once and swap in the highlighted one from a worker thread.
    let t = Instant::now();
    let plain = DiffView::build_plain(&text);
    let plain_ms = t.elapsed().as_millis();
    let t = Instant::now();
    let v = DiffView::build(&text, "big.rs", ThemeKind::Dark);
    let view_ms = t.elapsed().as_millis();
    assert_eq!(plain.rows.len(), v.rows.len());
    assert_eq!(v.rows.iter().filter(|r| r.kind == RowKind::Add).count(), 10_000);
    assert!(v.rows.iter().any(|r| r.spans.iter().any(|s| s.changed)), "word marks");

    eprintln!("log+refs {log_ms} ms, graph {graph_ms} ms, git diff {diff_ms} ms, plain diff view {plain_ms} ms, highlighted {view_ms} ms");
    // Generous bounds: CI runners are slow and this crate is built without optimisations in tests.
    assert!(graph_ms < 3000 && view_ms < 20_000, "too slow");
}
