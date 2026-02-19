use std::path::PathBuf;

use style_pipeline::{compile, CompileRequest, PipelineConfig, PipelineError, SourceMapMode};

fn temp_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("style_pipeline_{label}_{nanos}"));
    std::fs::create_dir_all(&dir).expect("temp dir should be created");
    dir
}

#[test]
fn discovery_picks_only_main_entries_and_plans_outputs() {
    let cwd = temp_dir("discovery");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(&src_dir).expect("src dir should exist");

    std::fs::write(src_dir.join("_main.css"), ".a{color:red;}").expect("fixture should be written");
    std::fs::write(src_dir.join("_main-desk.css"), ".b{display:block;}")
        .expect("fixture should be written");
    std::fs::write(src_dir.join("main.css"), ".skip{}").expect("fixture should be written");
    std::fs::write(src_dir.join("_not-main.css"), ".skip{}").expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::External;

    let result = compile(CompileRequest { cwd, config: cfg }).expect("compile should succeed");

    assert_eq!(result.artifacts.len(), 2);
    assert_eq!(result.artifacts[0].css_path, PathBuf::from("assets/css/main-desk.css"));
    assert_eq!(
        result.artifacts[0].map_path,
        Some(PathBuf::from("assets/css/maps/main-desk.css.map"))
    );
    assert_eq!(result.artifacts[1].css_path, PathBuf::from("assets/css/main.css"));
    assert_eq!(
        result.artifacts[1].map_path,
        Some(PathBuf::from("assets/css/maps/main.css.map"))
    );
}

#[test]
fn compile_fails_when_discovery_finds_no_entries() {
    let cwd = temp_dir("no_entries");
    std::fs::create_dir_all(cwd.join("assets/css/src")).expect("src dir should exist");
    std::fs::write(cwd.join("assets/css/src/other.css"), ".x{}").expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");

    let err = compile(CompileRequest { cwd, config: cfg }).expect_err("compile should fail");
    assert_eq!(
        err,
        PipelineError::InvalidConfig(
            "No entry files matching _main*.css were found in <out_dir>/src".to_string()
        )
    );
}

#[test]
fn output_map_is_absent_when_source_maps_are_not_external() {
    let cwd = temp_dir("inline_map");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(&src_dir).expect("src dir should exist");
    std::fs::write(src_dir.join("_main.css"), ".a{color:red;}").expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::Inline;

    let result = compile(CompileRequest { cwd, config: cfg }).expect("compile should succeed");
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].css_path, PathBuf::from("assets/css/main.css"));
    assert_eq!(result.artifacts[0].map_path, None);
}
