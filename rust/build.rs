use std::path::PathBuf;

fn main() {
    // 把生成的图标资源链接进 exe（Windows 的文件图标）。
    // macOS / Linux 没有 .res 这种东西，跳过，否则链接器会报错。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let res = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/icon.res");
        if res.exists() {
            println!("cargo:rustc-link-arg={}", res.display());
        }
        // 图标变化时重新链接
        println!("cargo:rerun-if-changed=assets/icon.res");
    }
    println!("cargo:rerun-if-changed=assets/icon.rgba");
}
