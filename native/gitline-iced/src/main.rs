// cargo run -p gitline-iced -- /path/to/repo
use gitline_iced::{App, Highlighting, style};

fn main() -> iced::Result {
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::current_dir().expect("current dir"));
    let repo = gitline_core::Repo::new(&path);
    if let Err(e) = gitline_core::session::Session::open(repo.clone()) {
        eprintln!("Couldn't open {}: {e}", path.display());
        std::process::exit(1);
    }
    iced::application(move || App::open(repo.clone(), Highlighting::Background).expect("opened above"), App::update, App::view)
        .title(App::title)
        .theme(|_: &App| style::theme())
        .settings(style::settings())
        .window(iced::window::Settings {
            size: iced::Size::new(1280.0, 800.0),
            min_size: Some(iced::Size::new(960.0, 640.0)),
            ..Default::default()
        })
        .run()
}
