use std::path::PathBuf;

fn main() {
    // 把生成的图标资源链接进 exe（文件图标）
    let res = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/icon.res");
    if res.exists() {
        println!("cargo:rustc-link-arg={}", res.display());
    }
    // 图标变化时重新链接
    println!("cargo:rerun-if-changed=assets/icon.res");
    println!("cargo:rerun-if-changed=assets/icon.rgba");
}
