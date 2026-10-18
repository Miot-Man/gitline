//! Creates a large repo for trying the native front ends:
//!
//!     cargo run -p gitline-core --example make_big_repo -- /tmp/big-repo [commits] [diff-lines]
//!
//! It has 6,000 commits by default (with merged feature branches and tags), and `big.rs` rewritten in
//! the work tree, so its unstaged diff has 2 x 10,000 changed lines.
#[path = "../tests/common/big.rs"]
mod big;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("usage: make_big_repo <folder> [commits] [diff-lines]");
    let commits = args.next().map_or(6000, |n| n.parse().expect("commits"));
    let lines = args.next().map_or(10_000, |n| n.parse().expect("diff-lines"));
    if std::path::Path::new(&dir).join(".git").exists() {
        eprintln!("{dir} is already a repo; pick an empty folder");
        std::process::exit(1);
    }
    big::make_big_repo(&gitline_core::Repo::new(&dir), commits, lines);
    println!("Created {dir} with {commits} commits and a {lines}-line rewrite of big.rs");
}
