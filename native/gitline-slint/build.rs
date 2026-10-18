fn main() {
    // The flat dark design is drawn by our own components; the std widgets (text fields, scroll bars)
    // use Fluent's dark variant unless SLINT_STYLE picks another (cupertino-dark, material-dark, qt).
    let style = std::env::var("SLINT_STYLE").unwrap_or_else(|_| "fluent-dark".into());
    println!("cargo:rerun-if-env-changed=SLINT_STYLE");
    let config = slint_build::CompilerConfiguration::new().with_style(style);
    slint_build::compile_with_config("ui/app.slint", config).expect("compile ui/app.slint");
}
