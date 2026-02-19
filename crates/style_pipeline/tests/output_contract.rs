use std::path::PathBuf;

use serde_json::Value;
use style_pipeline::{compile, CompileRequest, PipelineConfig, PipelineError, SourceMapMode, Targets};

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

#[test]
fn external_sourcemap_is_written_and_valid_json() {
    let cwd = temp_dir("external_map_valid");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(&src_dir).expect("src dir should exist");
    std::fs::write(src_dir.join("_main.css"), ".a { color: red; }\n").expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::External;

    let result = compile(CompileRequest {
        cwd: cwd.clone(),
        config: cfg,
    })
    .expect("compile should succeed");

    assert_eq!(result.artifacts.len(), 1);
    let css_path = cwd.join(&result.artifacts[0].css_path);
    let map_path = cwd.join(
        result.artifacts[0]
            .map_path
            .clone()
            .expect("map path should exist for external sourcemaps"),
    );

    let css = std::fs::read_to_string(css_path).expect("css output should exist");
    assert!(
        css.contains("sourceMappingURL=maps/main.css.map"),
        "css should contain map annotation"
    );

    let map_raw = std::fs::read_to_string(map_path).expect("map output should exist");
    let map_json: Value = serde_json::from_str(&map_raw).expect("map must be valid json");
    let sources = map_json["sources"]
        .as_array()
        .expect("sources must be an array");
    assert!(!sources.is_empty(), "sources should not be empty");
    let mappings = map_json["mappings"]
        .as_str()
        .expect("mappings must be a string");
    assert!(!mappings.is_empty(), "mappings should not be empty");
}

#[test]
fn minify_option_changes_css_output_shape() {
    let cwd = temp_dir("minify");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(&src_dir).expect("src dir should exist");
    std::fs::write(
        src_dir.join("_main.css"),
        ".a {\n  color: red;\n}\n.b {\n  display: block;\n}\n",
    )
    .expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::None;
    cfg.minify = true;

    compile(CompileRequest {
        cwd: cwd.clone(),
        config: cfg,
    })
    .expect("compile should succeed");

    let css = std::fs::read_to_string(cwd.join("assets/css/main.css")).expect("css output should exist");
    assert!(!css.contains('\n'), "minified output should not contain newlines");
    assert!(css.contains(".a{color:red}"), "minified output should contain compact rule");
}

#[test]
fn accepts_browserslist_query_in_targets() {
    let cwd = temp_dir("targets_query");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(&src_dir).expect("src dir should exist");
    std::fs::write(src_dir.join("_main.css"), ":focus-visible { color: red; }\n")
        .expect("fixture should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::None;
    cfg.targets = Targets {
        query: Some("last 2 versions".to_string()),
    };

    let result = compile(CompileRequest { cwd, config: cfg });
    assert!(result.is_ok(), "valid browserslist query should be accepted");
}

#[test]
fn resolves_imports_from_entry_dir_and_import_roots() {
    let cwd = temp_dir("imports_roots");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(src_dir.join("modules")).expect("src modules dir should exist");
    std::fs::create_dir_all(cwd.join("shared/styles/lib")).expect("shared lib dir should exist");

    std::fs::write(
        src_dir.join("_main.css"),
        "@import 'modules/_local';\n@import 'lib/_helpers';\n",
    )
    .expect("entry should be written");
    std::fs::write(src_dir.join("modules/_local.css"), ".local { color: red; }\n")
        .expect("local import should be written");
    std::fs::write(cwd.join("shared/styles/lib/_helpers.css"), ".helper { display: block; }\n")
        .expect("root import should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::None;
    cfg.import_roots = vec![PathBuf::from("shared/styles")];

    compile(CompileRequest {
        cwd: cwd.clone(),
        config: cfg,
    })
    .expect("compile should succeed");

    let css = std::fs::read_to_string(cwd.join("assets/css/main.css")).expect("css output should exist");
    assert!(css.contains(".local"), "local imported CSS should be included");
    assert!(css.contains(".helper"), "import from root path should be included");
}

#[test]
fn legacy_url_rewrite_applies_to_imported_content() {
    let cwd = temp_dir("import_url_rewrite");
    let src_dir = cwd.join("assets/css/src");
    std::fs::create_dir_all(src_dir.join("modules")).expect("src modules dir should exist");

    std::fs::write(src_dir.join("_main.css"), "@import 'modules/_feature';\n")
        .expect("entry should be written");
    std::fs::write(
        src_dir.join("modules/_feature.css"),
        ".icon { background-image: url(icon.svg); }\n",
    )
    .expect("imported css should be written");

    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::None;

    compile(CompileRequest {
        cwd: cwd.clone(),
        config: cfg,
    })
    .expect("compile should succeed");

    let css = std::fs::read_to_string(cwd.join("assets/css/main.css")).expect("css output should exist");
    assert!(
        css.contains("/assets/css/src/modules/icon.svg"),
        "rewritten URL should use project-root absolute path"
    );
}
