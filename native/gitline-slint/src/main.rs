// cargo run -p gitline-slint -- /path/to/repo
use slint::ComponentHandle;

fn main() {
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::current_dir().expect("current dir"));
    match gitline_slint::open(&path, gitline_slint::Highlighting::Background) {
        Ok((app, _controller)) => app.run().expect("event loop"),
        Err(e) => {
            eprintln!("Couldn't open {}: {e}", path.display());
            std::process::exit(1);
        }
    }
}
