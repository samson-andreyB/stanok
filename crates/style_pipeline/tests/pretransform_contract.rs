use std::path::PathBuf;

use style_pipeline::{CompileRequest, Entry, PipelineConfig, SourceMapMode};

fn temp_dir(tag: &str) -> PathBuf {
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("style-pipeline-pretransform-{tag}-{uniq}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should be created");
    dir
}

fn compile_one_entry(cwd: &PathBuf) -> String {
    let mut cfg = PipelineConfig::default();
    cfg.out_dir = PathBuf::from("assets/css");
    cfg.source_maps = SourceMapMode::None;
    cfg.entries = vec![Entry {
        input: PathBuf::from("assets/css/src/_main.css"),
    }];

    style_pipeline::compile(CompileRequest {
        cwd: cwd.clone(),
        config: cfg,
    })
    .expect("compile should succeed");

    std::fs::read_to_string(cwd.join("assets/css/main.css")).expect("css output should exist")
}

#[test]
fn pretransform_contract_covers_all_legacy_stages() {
    let cwd = temp_dir("all");
    let src = cwd.join("assets/css/src");
    let modules = src.join("modules");
    let img_dest = cwd.join("assets/img/dest");
    std::fs::create_dir_all(&modules).expect("src modules dir should exist");
    std::fs::create_dir_all(&img_dest).expect("img dest dir should exist");

    std::fs::write(
        src.join("_main.css"),
        "@import 'modules/_parts';\n/* @import 'modules/_skip'; */\n",
    )
    .expect("entry should be written");

    std::fs::write(
        modules.join("_parts.css"),
        r#"
            $brand: #123456;
            @define-mixin hoverTone {
                &:hover { color: $brand; }
            }

            .TBase { font-size: 10px; }

            .TCard {
                @extend .TBase;
                @mixin hoverTone;

                &__icon {
                    background: url(tile.png);
                    background-image: resolve('icon.png');
                    width: width('icon.png');
                    height: height('icon.png');
                }

                &__glyph {
                    background-image: svg("glyph", "[color]: #d0011b");
                }
            }
        "#,
    )
    .expect("module should be written");
    std::fs::write(modules.join("_skip.css"), ".TSkipped { color: red; }\n")
        .expect("commented module should be written");

    // Minimal PNG bytes with IHDR 16x32.
    std::fs::write(
        modules.join("icon.png"),
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x20\x08\x06\0\0\0",
    )
    .expect("icon png should be written");
    std::fs::write(
        img_dest.join("glyph.svg"),
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#000" stroke="#000" d="M1 1L9 9"/></svg>"##,
    )
    .expect("glyph svg should be written");

    let css = compile_one_entry(&cwd);
    let compact = css.replace([' ', '\n', '\t', '\r'], "");

    assert!(!css.contains("@import"));
    assert!(!css.contains("@define-mixin"));
    assert!(!css.contains("@mixin"));
    assert!(!css.contains("@extend"));
    assert!(!css.contains(".TSkipped"));

    assert!(compact.contains(".TBase,.TCard{"));
    assert!(css.contains(".TCard__icon"));
    assert!(css.contains(r#"url("/assets/css/src/modules/tile.png")"#));
    assert!(css.contains(r#"url("/assets/css/src/modules/icon.png")"#));
    assert!(compact.contains("width:16px"));
    assert!(compact.contains("height:32px"));
    assert!(css.contains("data:image/svg+xml"));
    assert!(css.contains("%23d0011b"));
}
