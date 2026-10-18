// Builds a large repo quickly with `git fast-import`: `commits` commits on main, with a short feature
// branch merged back every 40 commits (so the graph has lanes), a few tags, and `big.rs`, a file whose
// `big_lines` lines are all rewritten in the work tree (a diff of 2 x big_lines changed lines).
use std::io::Write;
use std::process::Stdio;

use gitline_core::Repo;

pub fn make_big_repo(repo: &Repo, commits: usize, big_lines: usize) {
    repo.init().unwrap();
    let mut s = String::new();
    let mut mark = 0;
    let mut time = 1_600_000_000u64;
    let mut commit = |s: &mut String, branch: &str, from: Option<usize>, merge: Option<usize>, msg: &str, files: &[(String, String)]| {
        mark += 1;
        time += 60;
        s.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\ncommitter Test User <test@example.com> {time} +0000\n"));
        s.push_str(&format!("data {}\n{msg}\n", msg.len() + 1));
        if let Some(f) = from {
            s.push_str(&format!("from :{f}\n"));
        }
        if let Some(m) = merge {
            s.push_str(&format!("merge :{m}\n"));
        }
        for (path, content) in files {
            s.push_str(&format!("M 100644 inline {path}\ndata {}\n{content}\n", content.len()));
        }
        mark
    };
    let big: String = (0..big_lines).map(|i| format!("fn item_{i}() -> u32 {{ {i} }} // original line {i}\n")).collect();
    let mut main = commit(&mut s, "main", None, None, "Initial commit", &[("big.rs".into(), big), ("README.md".into(), "# Big\n".into())]);
    let mut i = 1;
    let mut feature = 0;
    while i < commits {
        if i % 40 == 10 && i + 5 < commits {
            feature += 1;
            let name = format!("feature-{feature}");
            let mut tip = main;
            for k in 0..3 {
                let file = (format!("src/feature_{feature}.rs"), format!("// step {k}\npub fn f() {{}}\n"));
                tip = commit(&mut s, &name, Some(tip), None, &format!("Feature {feature}: step {}", k + 1), &[file]);
            }
            // Main moves on meanwhile, then merges the branch.
            main = commit(
                &mut s,
                "main",
                Some(main),
                None,
                &format!("Commit {i} on main"),
                &[(format!("src/file_{}.rs", i % 50), format!("pub const N: u32 = {i};\n"))],
            );
            main = commit(&mut s, "main", Some(main), Some(tip), &format!("Merge branch '{name}'"), &[]);
            i += 5;
            continue;
        }
        main = commit(
            &mut s,
            "main",
            Some(main),
            None,
            &format!("Commit {i}: tweak file {}", i % 50),
            &[(format!("src/file_{}.rs", i % 50), format!("pub const N: u32 = {i};\n"))],
        );
        if i % 500 == 0 {
            s.push_str(&format!("reset refs/tags/v{}\nfrom :{main}\n\n", i / 500));
        }
        i += 1;
    }
    let mut child = gitline_core::git::command(&repo.path, &["fast-import".as_ref(), "--quiet".as_ref()], &[])
        .envs([("GIT_CONFIG_NOSYSTEM", "1")])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    repo.git(&["checkout", "-q", "-f", "main"]).unwrap();
    let rewritten: String = (0..big_lines).map(|i| format!("fn item_{i}() -> u64 {{ {} }} // changed line {i}\n", i * 2)).collect();
    std::fs::write(repo.path.join("big.rs"), rewritten).unwrap();
}
