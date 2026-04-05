use super::*;

#[test]
fn detects_likely_text_paths_from_common_editor_extensions() {
    assert!(is_likely_text_path("src/App.svelte"));
    assert!(is_likely_text_path("Dockerfile"));
    assert!(!is_likely_text_path("assets/image.png"));
    assert!(!is_likely_text_path("bin/program"));
}

#[test]
fn infer_language_id_detects_php_family_files() {
    assert_eq!(
        infer_language_id("/home/user/work/project/app/Controller.php"),
        "php"
    );
    assert_eq!(
        infer_language_id("/home/user/work/project/views/index.phtml"),
        "php"
    );
    assert_eq!(
        infer_language_id("/home/user/work/project/resources/views/welcome.blade.php"),
        "php"
    );
}
