#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
//! GitHub Release 下载整理工具 v1.2
//! 原生窗口界面（egui），单文件可执行，无需任何运行时。
//! 支持自动线路测速：直连 / 多个加速镜像择优。

use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eframe::egui;
use serde_json::Value;

const APP_NAME: &str = "GitHub Release 下载整理工具";
const APP_VERSION: &str = "1.6.1";
const USER_AGENT: &str = "ReleaseOrganizer/1.6.1";

/// 断点续传的清单文件后缀：和目标文件放在同一个目录，记下原始下载地址与大小
const META_EXT: &str = ".part.meta";

/// 下载开始时弹出的小卡片里用到的两个地址
const PROMO_URL: &str = "https://loomy.cgref.cn/qinxi";
const MORE_URL: &str = "https://sucaizy.com";

/// 三处悬停说明的文案（标题, 正文）
const TIP_LATEST: (&str, &str) = (
    "只取最新版本",
    "每个仓库只保留「最新那一个 Release」里的文件，忽略历史版本。\n\n✓ 勾选：列表只出现最新版（推荐，下载安装包通常只用最新）\n· 取消：历史版本也一起列出，方便回退到旧版\n\n和「包含 Pre-release」一起生效。",
);

const TIP_PRE: (&str, &str) = (
    "Pre-release 是什么",
    "Pre-release 是作者主动标记的「预发布版」，属于测试性质，常见后缀有 beta / rc / alpha / nightly / dev。\n\n✓ 勾选：测试版也一起列出来。功能最新，但可能崩溃、可能有破坏性改动\n· 取消：只保留正式稳定版。日常使用建议取消勾选\n\n怎么认：版本号里带 -beta.3、-rc1 这类后缀的，基本都是 Pre-release。\n作者在 GitHub 发布页勾了「Set as a pre-release」，它就会出现在这里。",
);

const TIP_TOKEN: (&str, &str) = (
    "Token 怎么获取",
    "Token 是 GitHub 的个人访问令牌。不填也能用，只是每小时只有 60 次请求；仓库填得多、反复扫描时会报 403 被限流。\n\n1 打开 github.com，点右上角头像 → Settings\n2 左侧菜单拉到最底 → Developer settings\n3 Personal access tokens → Tokens (classic)\n4 点 Generate new token (classic)\n5 勾选 public_repo（要读私有仓库再加 repo）\n6 复制 ghp_ 开头的字符串，粘贴到左边框\n\n令牌只完整显示一次，记得先存好；填了 Token 额度从 60 次/小时提到 5000 次/小时。怀疑泄露可在同一页面点 Revoke 作废重发。",
);

const ERR_RED: egui::Color32 = egui::Color32::from_rgb(198, 48, 32);
/// 加速线路候选：前缀为空表示直连
const ROUTE_LIST: &[(&str, &str)] = &[
    ("直连", ""),
    ("gh-proxy.com", "https://gh-proxy.com/"),
    ("ghproxy.net", "https://ghproxy.net/"),
    ("gh-proxy.org", "https://gh-proxy.org/"),
    ("cors.isteed", "https://cors.isteed.cc/"),
    ("ghfast.top", "https://ghfast.top/"),
    ("moeyy", "https://github.moeyy.xyz/"),
    ("gitmirror", "https://hub.gitmirror.com/"),
];

// ---------------------------------------------------------------- 数据

#[derive(Clone)]
#[allow(dead_code)] // tag / arch 暂时只在扫描阶段用到，留着方便以后做版本区分
struct Row {
    repo: String,
    tag: String,
    asset: String,
    folder: String,
    arch: String,
    size: u64,
    url: String,
    target: String,
    selected: bool,
    /// 磁盘上已经下好的字节数（>0 说明这个文件有断点，可以直接续传）
    resume: u64,
}

#[derive(Clone, Default)]
struct Route {
    name: String,
    prefix: String,
    speed: f64,
    ok: bool,
}

#[derive(Clone, Default)]
#[allow(dead_code)] // asset / folder / target 供调试打印用，界面只读进度字段
struct FileProg {
    asset: String,
    folder: String,
    target: String,
    status: String,
    received: u64,
    total: u64,
    speed: f64,
    error: String,
    /// 下载过程中的临时提示（比如「连接被限速，正在换线路重连」）
    note: String,
}

enum Msg {
    Scan(Vec<Row>, Vec<String>),
    Routes(Vec<Route>),
}

// ---------------------------------------------------------------- 分类与命名

const WIN_EXTS: &[&str] = &[".exe", ".msi", ".msix", ".appx", ".msixbundle"];
const MAC_EXTS: &[&str] = &[".dmg", ".pkg", ".mpkg"];
const AMBIG_EXTS: &[&str] = &[
    ".zip", ".7z", ".tar", ".gz", ".tgz", ".xz", ".bz2", ".zst", ".tar.gz", ".tar.xz",
    ".tar.bz2", ".tar.zst", "",
];
const WIN_KEYS: &[&str] = &[
    "windows", "win32", "win64", "win-", "_win", "-win", "setup.exe", "installer.exe",
];
const MAC_KEYS: &[&str] = &[
    "macos", "mac-os", "mac_os", "darwin", "osx", "apple", "universal", "mac.", "mac-", "-mac",
    "_mac",
];

fn detect_arch(name: &str) -> String {
    let low = name.to_lowercase();
    if low.contains("arm64") || low.contains("aarch64") || low.contains("apple-silicon") {
        return "arm64".into();
    }
    if low.contains("x86_64")
        || low.contains("x86-64")
        || low.contains("amd64")
        || low.contains("x64")
        || low.contains("64bit")
        || low.contains("win64")
    {
        return "x64".into();
    }
    if low.contains("i386")
        || low.contains("i686")
        || low.contains("win32")
        || low.contains("x86")
        || low.contains("32bit")
        || low.contains("386")
    {
        return "x86".into();
    }
    "unknown".into()
}

fn ext_of(name: &str) -> String {
    let low = name.to_lowercase();
    for multi in [".tar.gz", ".tar.xz", ".tar.bz2", ".tar.zst"] {
        if low.ends_with(multi) {
            return multi.to_string();
        }
    }
    match low.rfind('.') {
        Some(i) => low[i..].to_string(),
        None => String::new(),
    }
}

fn is_ambiguous_ext(ext: &str) -> bool {
    AMBIG_EXTS.contains(&ext) || ext.starts_with(".tar")
}

fn classify(name: &str) -> (String, String, String) {
    let low = name.to_lowercase();
    let ext = ext_of(name);
    let arch = detect_arch(name);

    if WIN_EXTS.contains(&ext.as_str()) {
        return ("windows".into(), "Windows".into(), arch);
    }
    if MAC_EXTS.contains(&ext.as_str()) {
        return ("macos".into(), "macOS".into(), arch);
    }
    let has_win = WIN_KEYS.iter().any(|k| low.contains(k));
    let has_mac = MAC_KEYS.iter().any(|k| low.contains(k));

    if is_ambiguous_ext(&ext) {
        if has_mac && !has_win {
            return ("macos".into(), "macOS".into(), arch);
        }
        if has_win && !has_mac {
            return ("windows".into(), "Windows".into(), arch);
        }
        if has_win && has_mac {
            return ("windows".into(), "Windows".into(), "universal".into());
        }
        if low.contains("source") || low.contains("src") {
            return ("other".into(), "Others".into(), "unknown".into());
        }
        return ("other".into(), "Others".into(), arch);
    }
    ("other".into(), "Others".into(), arch)
}

fn safe_filename(text: &str, max_len: usize) -> String {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\r', '\n', '\t'];
    let s: String = text
        .chars()
        .map(|c| if bad.contains(&c) { '_' } else { c })
        .collect();
    let s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.chars().count() > max_len {
        s.chars().take(max_len).collect()
    } else if s.is_empty() {
        "unnamed".into()
    } else {
        s
    }
}

fn repo_short(full: &str) -> String {
    full.rsplit('/').next().unwrap_or(full).to_string()
}

fn build_target_name(repo: &str, tag: &str, filename: &str, platform: &str, arch: &str) -> String {
    let short = repo_short(repo);
    let mut tag_clean = tag.to_string();
    let repo_pre = format!("{}-", short.to_lowercase());
    if tag.to_lowercase().starts_with(&repo_pre) {
        tag_clean = tag[short.len() + 1..].to_string();
    }
    let tag = tag_clean.as_str();

    let mut fname = filename.to_string();
    for token in [short.as_str(), tag] {
        if token.is_empty() {
            continue;
        }
        let pre = format!("{}-", token.to_lowercase());
        if fname.to_lowercase().starts_with(&pre) {
            fname = fname[token.len() + 1..].to_string();
        }
    }

    let mut parts: Vec<String> = vec![short];
    if !tag.is_empty() && !fname.to_lowercase().contains(&tag.to_lowercase()) {
        parts.push(tag.to_string());
    }
    parts.push(platform.to_string());
    if arch != "unknown" && !arch.is_empty() {
        parts.push(arch.to_string());
    }
    safe_filename(&format!("{}-{}", parts.join("-"), fname), 180)
}

// ---------------------------------------------------------------- 网络

fn agent(timeout_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout_secs))
        .redirects(10)
        .build()
}

/// 下载专用的 agent。
///
/// 这里**不能**用 `.timeout(整体时限)`：那是「从发请求到读完 body」的总时长，
/// 一个 100MB 的文件在 300KB/s 下要 5 分多钟，45 秒的整体超时会把它强杀，
/// 表现就是「进度卡住不动 → 超时重连 → 又开始飞」，大文件必踩。
/// 改为只限制「单次读空闲」：只要对端还在吐数据就一直读，真卡死才断开重来。
fn dl_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(15))
        .timeout_write(Duration::from_secs(20))
        .redirects(10)
        .build()
}

/// 分片卡的判定：连续这么久没有明显进展就换条连接重来
const STALL_SECS: u64 = 10;
/// 这段时间内至少要下这么多，低于它按「卡住」处理
const STALL_MIN_BYTES: u64 = 48 * 1024;

/// 下载卡顿时给用户看的解释（悬停/详情用，讲清楚原因）
const NOTE_RECONNECT: &str = "这条连接被限速了，正在自动换一条线路重连，一般 5~15 秒恢复。\
GitHub 对大文件会限制单条连接的下载速度，多分片下载时某一片被卡住就会出现「进度停一会儿又飞快」，属正常现象，不用操作。";
/// 同一句话的短版，放在底部状态栏一行里
const NOTE_SHORT: &str = "连接卡顿，正在自动重连（约 5~15 秒），请稍候";

fn route_url(routes: &[(String, String)], i: usize, base: &str) -> String {
    match routes.get(i % routes.len().max(1)) {
        Some((_, prefix)) => format!("{}{}", prefix, base),
        None => base.to_string(),
    }
}

fn normalize_repo(text: &str) -> String {
    let mut s = text.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return String::new();
    }
    if s.ends_with(".git") {
        s.truncate(s.len() - 4);
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        let rest = s.splitn(2, "://").nth(1).unwrap_or("");
        let path = match rest.find('/') {
            Some(i) => &rest[i + 1..],
            None => "",
        };
        let segs: Vec<&str> = path.split('/').filter(|x| !x.is_empty()).collect();
        if segs.len() >= 2 {
            return format!("{}/{}", segs[0], segs[1]);
        }
        return String::new();
    }
    if s.starts_with("git@") {
        let after = s.trim_start_matches("git@");
        if let Some(i) = after.find(':').or_else(|| after.find('/')) {
            let segs: Vec<&str> = after[i + 1..]
                .split('/')
                .filter(|x| !x.is_empty())
                .collect();
            if segs.len() >= 2 {
                return format!("{}/{}", segs[0], segs[1]);
            }
        }
        return String::new();
    }
    let segs: Vec<&str> = s.split('/').filter(|x| !x.is_empty()).collect();
    if segs.len() >= 2 {
        return format!("{}/{}", segs[0], segs[1]);
    }
    String::new()
}

fn scan_repos(
    repos: &[String],
    token: &str,
    include_pre: bool,
    latest_only: bool,
) -> (Vec<Row>, Vec<String>) {
    let ag = agent(30);
    let mut rows: Vec<Row> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for repo in repos {
        let url = format!(
            "https://api.github.com/repos/{}/releases?per_page=10&page=1",
            repo
        );
        let mut req = ag.get(&url).set("Accept", "application/vnd.github+json");
        if !token.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", token));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(404, _)) => {
                errors.push(format!("{}：仓库不存在，或为私有仓库（需填 Token）", repo));
                continue;
            }
            Err(ureq::Error::Status(403, _)) => {
                errors.push(format!(
                    "{}：访问被拒（403），可能触发频率限制，填 Token 可提高额度",
                    repo
                ));
                continue;
            }
            Err(ureq::Error::Status(code, _)) => {
                errors.push(format!("{}：HTTP {}", repo, code));
                continue;
            }
            Err(e) => {
                errors.push(format!("{}：网络错误 —— {}", repo, e));
                continue;
            }
        };

        let value: Value = match resp.into_json() {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{}：解析失败 —— {}", repo, e));
                continue;
            }
        };
        let arr = match value.as_array() {
            Some(a) => a,
            None => {
                errors.push(format!("{}：返回格式异常", repo));
                continue;
            }
        };

        let mut count = 0usize;
        for rel in arr {
            if rel["draft"].as_bool().unwrap_or(false) {
                continue;
            }
            let pre = rel["prerelease"].as_bool().unwrap_or(false);
            if pre && !include_pre {
                continue;
            }
            let tag = rel["tag_name"]
                .as_str()
                .or_else(|| rel["name"].as_str())
                .unwrap_or("unknown")
                .to_string();

            let mut batch: Vec<Row> = Vec::new();
            if let Some(assets) = rel["assets"].as_array() {
                for a in assets {
                    let name = a["name"].as_str().unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let (platform, folder, arch) = classify(name);
                    batch.push(Row {
                        repo: repo.clone(),
                        tag: tag.clone(),
                        asset: name.to_string(),
                        folder: folder.clone(),
                        arch: arch.clone(),
                        size: a["size"].as_u64().unwrap_or(0),
                        url: a["browser_download_url"].as_str().unwrap_or("").to_string(),
                        target: build_target_name(repo, &tag, name, &folder, &arch),
                        selected: true,
                        resume: 0,
                    });
                    let _ = platform;
                }
            }
            if latest_only && batch.is_empty() {
                continue;
            }
            count += batch.len();
            rows.extend(batch);
            if latest_only {
                break;
            }
        }
        if count == 0 {
            errors.push(format!("{}：没有符合条件的 Release 资源", repo));
        }
    }

    rows.sort_by(|a, b| {
        (a.folder.as_str(), a.repo.as_str(), a.asset.as_str()).cmp(&(
            b.folder.as_str(),
            b.repo.as_str(),
            b.asset.as_str(),
        ))
    });
    (rows, errors)
}

// ---------------------------------------------------------------- 线路测速

fn probe_one(name: &str, prefix: &str, url: &str) -> Route {
    let full = format!("{}{}", prefix, url);
    let ag = agent(13);
    let started = Instant::now();
    let mut route = Route {
        name: name.to_string(),
        prefix: prefix.to_string(),
        speed: 0.0,
        ok: false,
    };
    let resp = match ag
        .get(&full)
        .set("Range", "bytes=0-1048575")
        .set("Accept", "application/octet-stream")
        .call()
    {
        Ok(r) => r,
        Err(_) => return route,
    };
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut got: u64 = 0;
    while got < 1024 * 1024 {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => got += n as u64,
            Err(_) => break,
        }
        if started.elapsed() > Duration::from_secs(7) {
            break;
        }
    }
    let secs = started.elapsed().as_secs_f64().max(0.05);
    if got > 0 {
        route.ok = true;
        route.speed = got as f64 / secs;
    }
    route
}

fn probe_routes(url: &str) -> Vec<Route> {
    let (tx, rx) = channel::<(usize, Route)>();
    for (i, (name, prefix)) in ROUTE_LIST.iter().enumerate() {
        let tx = tx.clone();
        let url = url.to_string();
        let name = name.to_string();
        let prefix = prefix.to_string();
        std::thread::spawn(move || {
            let r = probe_one(&name, &prefix, &url);
            let _ = tx.send((i, r));
        });
    }
    drop(tx);

    let mut result: Vec<Option<Route>> = vec![None; ROUTE_LIST.len()];
    let deadline = Instant::now() + Duration::from_secs(14);
    let mut got = 0;
    while got < ROUTE_LIST.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok((i, r)) => {
                result[i] = Some(r);
                got += 1;
            }
            Err(_) => break,
        }
    }
    result
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            r.unwrap_or_else(|| Route {
                name: ROUTE_LIST[i].0.to_string(),
                prefix: ROUTE_LIST[i].1.to_string(),
                speed: 0.0,
                ok: false,
            })
        })
        .collect()
}

// ---------------------------------------------------------------- 下载

fn fmt_size(n: u64) -> String {
    if n == 0 {
        return "-".into();
    }
    let units = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 || v >= 100.0 {
        format!("{:.0} {}", v, units[i])
    } else {
        format!("{:.1} {}", v, units[i])
    }
}

fn fmt_speed(bps: f64) -> String {
    if bps <= 0.0 {
        return "-".into();
    }
    format!("{}/s", fmt_size(bps as u64))
}

fn set_prog(prog: &Arc<Mutex<Vec<FileProg>>>, idx: usize, f: impl FnOnce(&mut FileProg)) {    if let Ok(mut v) = prog.lock() {
        if let Some(p) = v.get_mut(idx) {
            f(p);
        }
    }
}

// ---------------------------------------------------------------- 断点续传

/// 截图自查用的假进度（RO_FAKE=1）：只影响显示，不碰磁盘
fn fake_prog(kind: &str) -> Arc<Mutex<Vec<FileProg>>> {
    let stalled = kind == "stall";
    let sp = |v: f64| if stalled { 0.0 } else { v };
    let nt = || if stalled { NOTE_RECONNECT.to_string() } else { String::new() };
    let mk = |asset: &str, folder: &str, recv: u64, total: u64, speed: f64, st: &str| FileProg {
        asset: asset.to_string(),
        folder: folder.to_string(),
        target: asset.to_string(),
        status: st.to_string(),
        received: recv,
        total,
        speed,
        error: String::new(),
        note: nt(),
    };
    let mb = 1024 * 1024;
    // 顺序按演示列表来：第 1 个已完成，后两个正在下
    Arc::new(Mutex::new(vec![
        mk(
            "GroupPolicyObjectFiles-0.103.3062.0.zip",
            "其他",
            9 * mb / 10,
            9 * mb / 10,
            0.0,
            "完成",
        ),
        mk(
            "symbols-arm64.zip",
            "Windows",
            130 * mb,
            380 * mb,
            sp(1_180_000.0),
            "下载中",
        ),
        mk(
            "symbols-x64.zip",
            "Windows",
            96 * mb,
            386 * mb,
            sp(640_000.0),
            "下载中",
        ),
    ]))
}

/// 一份未完成任务的身份信息，存成 <目标文件>.part.meta
#[derive(Clone, Default)]
struct Meta {
    repo: String,
    folder: String,
    asset: String,
    target: String,
    url: String,
    size: u64,
}

fn meta_path(dir: &PathBuf, target: &str) -> PathBuf {
    dir.join(format!("{}{}", target, META_EXT))
}

fn write_meta(dir: &PathBuf, row: &Row) {
    let body = format!(
        "v=1\nrepo={}\nfolder={}\nasset={}\ntarget={}\nsize={}\nurl={}\n",
        row.repo, row.folder, row.asset, row.target, row.size, row.url
    );
    let _ = std::fs::write(meta_path(dir, &row.target), body);
}

fn read_meta(path: &PathBuf) -> Option<Meta> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut m = Meta::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k {
            "repo" => m.repo = v.to_string(),
            "folder" => m.folder = v.to_string(),
            "asset" => m.asset = v.to_string(),
            "target" => m.target = v.to_string(),
            "size" => m.size = v.parse().unwrap_or(0),
            "url" => m.url = v.to_string(),
            _ => {}
        }
    }
    if m.target.is_empty() || m.url.is_empty() {
        None
    } else {
        Some(m)
    }
}

/// 断点已经下好的字节数：单连接是 <目标>.part，多连接是 <目标>.part0/1/2…
fn part_bytes(dir: &PathBuf, target: &str) -> u64 {
    let prefix = format!("{}.part", target);
    let mut sum = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && !name.ends_with(".meta") {
            sum += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    sum
}

/// 丢掉一个文件的全部断点（换成新版本、或断点数据已经不可用时）
fn clear_parts(dir: &PathBuf, target: &str) {
    let prefix = format!("{}.part", target);
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && !name.ends_with(".meta") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 启动时扫一遍保存目录，把上次没下完的任务找回来（只走 仓库/平台 两层，够快）
fn scan_pending(outdir: &str) -> Vec<(Meta, u64)> {
    let mut out: Vec<(Meta, u64)> = Vec::new();
    let root = PathBuf::from(outdir);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return out;
    };
    for repo_e in rd.flatten() {
        let p1 = repo_e.path();
        if !p1.is_dir() {
            continue;
        }
        let Ok(rd2) = std::fs::read_dir(&p1) else {
            continue;
        };
        for folder_e in rd2.flatten() {
            let p2 = folder_e.path();
            if !p2.is_dir() {
                continue;
            }
            let Ok(rd3) = std::fs::read_dir(&p2) else {
                continue;
            };
            for f in rd3.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if !name.ends_with(META_EXT) {
                    continue;
                }
                let Some(m) = read_meta(&f.path()) else {
                    continue;
                };
                let have = part_bytes(&p2, &m.target);
                // 一个字节都没有的断点没有续传意义，顺手清掉清单
                if have == 0 {
                    let _ = std::fs::remove_file(f.path());
                    continue;
                }
                out.push((m, have));
            }
        }
    }
    out.sort_by(|a, b| a.0.target.cmp(&b.0.target));
    out
}

/// 多连接分片下载。
/// 国内直连 GitHub 资源常被单连接限速，多开几条 Range 连接能成倍提速。
/// 返回 "RANGE_SKIP"（文件太小，不分片）/"RANGE_UNSUPPORTED"（该线路不支持 Range）时，
/// 调用方应回退到单连接下载。
fn download_segmented(
    base_url: &str,
    routes: &[(String, String)],
    route0: usize,
    dir: &PathBuf,
    target: &str,
    size: u64,
    prog: &Arc<Mutex<Vec<FileProg>>>,
    idx: usize,
    cancel: &Arc<AtomicBool>,
) -> Result<u64, String> {
    let segs: u64 = if size >= 16 * 1024 * 1024 {
        8
    } else if size >= 6 * 1024 * 1024 {
        6
    } else if size >= 2 * 1024 * 1024 {
        4
    } else {
        1
    };
    if segs <= 1 {
        return Err("RANGE_SKIP".to_string());
    }

    let counter = Arc::new(AtomicU64::new(0));
    let unsupported = Arc::new(AtomicBool::new(false));
    let broken = Arc::new(AtomicBool::new(false));
    // 每段下到哪了 + 「请重连」信号。用来揪出被限速拖后腿的段：
    // 一条连接被运营商/GitHub 单连接限速时不会报错，就是慢慢爬，
    // 光看「有没有数据」发现不了，得跟同伴比才知道它是在爬。
    let seg_done: Arc<Vec<AtomicU64>> = Arc::new((0..segs).map(|_| AtomicU64::new(0)).collect());
    let kick: Arc<Vec<AtomicBool>> = Arc::new((0..segs).map(|_| AtomicBool::new(false)).collect());
    let kick_cnt: Arc<Vec<AtomicU64>> = Arc::new((0..segs).map(|_| AtomicU64::new(0)).collect());
    let per = size / segs;
    let mut handles = Vec::new();
    let routes = Arc::new(routes.to_vec());
    let base = Arc::new(base_url.to_string());

    for i in 0..segs {
        let start = i * per;
        let end = if i + 1 == segs {
            size - 1
        } else {
            (i + 1) * per - 1
        };
        let seg_path = dir.join(format!("{}.part{}", target, i));
        let expect = end - start + 1;
        let have = std::fs::metadata(&seg_path).map(|m| m.len()).unwrap_or(0);
        counter.fetch_add(have.min(expect), Ordering::SeqCst);
        seg_done[i as usize].store(have.min(expect), Ordering::SeqCst);

        let counter2 = counter.clone();
        let cancel2 = cancel.clone();
        let unsupported2 = unsupported.clone();
        let broken2 = broken.clone();
        let routes2 = routes.clone();
        let base2 = base.clone();
        let sd2 = seg_done.clone();
        let kick2 = kick.clone();
        let si = i as usize;

        handles.push(std::thread::spawn(move || {
            // 一条连接被限速/挂死时，换下一条线路往往能立刻恢复，
            // 所以每次重试都往后挪一条线路，而不是死磕同一条。
            let mut route = route0;
            let mut fails: u32 = 0;
            loop {
                if cancel2.load(Ordering::SeqCst) {
                    return;
                }
                kick2[si].store(false, Ordering::SeqCst);
                let have = std::fs::metadata(&seg_path).map(|m| m.len()).unwrap_or(0);
                // 以磁盘上的真实进度为准，避免被踢时少算/多算
                sd2[si].store(have.min(expect), Ordering::SeqCst);
                if have >= expect {
                    // 断点比预期还长（上次合并出过错）→ 截到该分片的正常长度
                    if have > expect {
                        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&seg_path) {
                            let _ = f.set_len(expect);
                        }
                    }
                    return;
                }
                if fails >= 8 {
                    broken2.store(true, Ordering::SeqCst);
                    return;
                }
                let url = route_url(&routes2, route, &base2);
                let from = start + have;
                let ag = dl_agent();
                let resp = ag
                    .get(&url)
                    .set("Range", &format!("bytes={}-{}", from, end))
                    .call();

                let resp = match resp {
                    Ok(r) => r,
                    Err(ureq::Error::Status(416, _)) => return,
                    Err(_) => {
                        fails += 1;
                        route += 1;
                        std::thread::sleep(Duration::from_millis(300 + fails as u64 * 200));
                        continue;
                    }
                };
                // 服务端不支持分段（返回 200 整包）
                if resp.status() != 206 {
                    // 主线路就不支持 → 整个文件回退单连接；换线后的线路不支持 → 只换下一条
                    if route == route0 {
                        unsupported2.store(true, Ordering::SeqCst);
                        return;
                    }
                    fails += 1;
                    route += 1;
                    continue;
                }
                let mut f = match std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&seg_path)
                {
                    Ok(f) => f,
                    Err(_) => {
                        broken2.store(true, Ordering::SeqCst);
                        return;
                    }
                };
                let mut reader = resp.into_reader();
                let mut buf = vec![0u8; 256 * 1024];
                let mut clean = false;
                // 本次连接读到的字节数，用来判断这条连接是不是「在爬」
                let mut conn: u64 = 0;
                let mut mark: u64 = 0;
                let mut mark_t = Instant::now();
                loop {
                    if cancel2.load(Ordering::SeqCst) {
                        let _ = f.flush();
                        return;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            clean = true;
                            break;
                        }
                        Ok(n) => {
                            if f.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            conn += n as u64;
                            counter2.fetch_add(n as u64, Ordering::SeqCst);
                            sd2[si].fetch_add(n as u64, Ordering::SeqCst);
                            // 比同伴慢太多，被判为拖后腿 → 断开换连接
                            if kick2[si].load(Ordering::SeqCst) {
                                break;
                            }
                            // 爬行检测：STALL_SECS 内没下够 STALL_MIN_BYTES 就换连接
                            if mark_t.elapsed().as_secs() >= STALL_SECS {
                                if conn - mark < STALL_MIN_BYTES {
                                    break;
                                }
                                mark = conn;
                                mark_t = Instant::now();
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = f.flush();
                drop(f);
                if clean {
                    return;
                }
                fails += 1;
                route += 1;
                std::thread::sleep(Duration::from_millis(300 + fails as u64 * 200));
            }
        }));
    }

    // 每段应下的长度，用于判断「还剩多少没下」
    let seg_len: Vec<u64> = (0..segs)
        .map(|i| {
            let start = i * per;
            let end = if i + 1 == segs {
                size - 1
            } else {
                (i + 1) * per - 1
            };
            end - start + 1
        })
        .collect();
    let mut last_seg: Vec<u64> = (0..segs as usize)
        .map(|i| seg_done[i].load(Ordering::SeqCst))
        .collect();
    let mut last_check = Instant::now();

    // 等待期间持续刷新进度，同时盯着各段速度
    loop {
        if handles.iter().all(|h| h.is_finished()) || cancel.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
        let c = counter.load(Ordering::SeqCst).min(size);
        set_prog(prog, idx, |p| {
            p.received = c;
            p.total = size;
        });

        if last_check.elapsed() >= Duration::from_millis(1500) {
            let dt = last_check.elapsed().as_secs_f64();
            last_check = Instant::now();
            let now: Vec<u64> = (0..segs as usize)
                .map(|i| seg_done[i].load(Ordering::SeqCst))
                .collect();
            let mut sum = 0.0f64;
            let mut n = 0usize;
            let mut rates: Vec<Option<f64>> = vec![None; segs as usize];
            for i in 0..segs as usize {
                if now[i] < seg_len[i] {
                    let r = now[i].saturating_sub(last_seg[i]) as f64 / dt;
                    rates[i] = Some(r);
                    sum += r;
                    n += 1;
                }
            }
            // 比同伴慢一大截的段：连接被限速了但没报错，主动断开换一条
            for i in 0..segs as usize {
                let Some(r) = rates[i] else { continue };
                let remain = seg_len[i] - now[i];
                let slow_vs_peers = n >= 2 && r * 3.0 < sum / n as f64;
                // 只剩最后一段时没有同伴可比，速度低得离谱也换一次试试
                let last_one = n == 1 && r < 300_000.0;
                if (slow_vs_peers || last_one)
                    && remain > 256 * 1024
                    && kick_cnt[i].load(Ordering::SeqCst) < 3
                {
                    kick_cnt[i].fetch_add(1, Ordering::SeqCst);
                    kick[i].store(true, Ordering::SeqCst);
                }
            }
            let slowed = (0..segs as usize)
                .any(|i| kick_cnt[i].load(Ordering::SeqCst) > 0 && now[i] < seg_len[i]);
            set_prog(prog, idx, |p| {
                p.note = if slowed {
                    NOTE_RECONNECT.into()
                } else {
                    String::new()
                };
            });
            last_seg = now;
        }
    }
    for h in handles {
        let _ = h.join();
    }

    let drop_segs = |dir: &PathBuf| {
        for i in 0..segs {
            let _ = std::fs::remove_file(dir.join(format!("{}.part{}", target, i)));
        }
    };

    // 服务器不吃 Range：分片结构对后续单连接没用，直接清掉重来
    if unsupported.load(Ordering::SeqCst) {
        drop_segs(dir);
        return Err("RANGE_UNSUPPORTED".to_string());
    }
    // 用户点了停止 / 某个分片彻底失败：分片留在磁盘上，下次接着下
    if cancel.load(Ordering::SeqCst) {
        return Err("CANCELLED".to_string());
    }
    if broken.load(Ordering::SeqCst) {
        return Err("分片下载中断（断点已保留）".to_string());
    }

    // 合并前先核对分片总长，缺一块就别拼出一个坏文件
    let mut merged_len = 0u64;
    for i in 0..segs {
        merged_len += std::fs::metadata(dir.join(format!("{}.part{}", target, i)))
            .map(|m| m.len())
            .unwrap_or(0);
    }
    if merged_len != size {
        return Err(format!("分片不完整（{}/{}），断点已保留", merged_len, size));
    }

    // 按顺序合并分片。合并是纯磁盘活，几秒内完成，但界面要说明白在干什么，
    // 否则用户看到进度停在 100% 会以为卡死了。
    set_prog(prog, idx, |p| {
        p.status = "合并中".into();
        p.received = size;
        p.total = size;
        p.speed = 0.0;
    });
    let part_path = dir.join(format!("{}.part", target));
    let f = std::fs::File::create(&part_path).map_err(|e| format!("无法写入文件：{}", e))?;
    let mut out = std::io::BufWriter::with_capacity(8 * 1024 * 1024, f);
    for i in 0..segs {
        let seg_path = dir.join(format!("{}.part{}", target, i));
        let mut f = std::fs::File::open(&seg_path).map_err(|e| format!("读取分片失败：{}", e))?;
        std::io::copy(&mut f, &mut out).map_err(|e| format!("合并分片失败：{}", e))?;
        drop(f);
        let _ = std::fs::remove_file(&seg_path);
    }
    let _ = out.flush();
    let f = out.into_inner().map_err(|e| format!("合并分片失败：{}", e))?;
    let _ = f.set_len(size);
    drop(f);

    set_prog(prog, idx, |p| {
        p.received = size;
        p.total = size;
    });
    Ok(size)
}

fn download_one(
    row: &Row,
    outdir: &str,
    routes: &[(String, String)],
    prog: &Arc<Mutex<Vec<FileProg>>>,
    cancel: &Arc<AtomicBool>,
    idx: usize,
) {
    if cancel.load(Ordering::SeqCst) {
        set_prog(prog, idx, |p| p.status = "已取消".into());
        return;
    }

    // 每个项目单独一个文件夹：<保存目录>/<仓库名>/<平台>/
    let dir = PathBuf::from(outdir)
        .join(repo_short(&row.repo))
        .join(&row.folder);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        set_prog(prog, idx, |p| {
            p.status = "失败".into();
            p.error = format!("无法创建目录：{}", e);
        });
        return;
    }
    let dest = dir.join(&row.target);
    let part = dir.join(format!("{}.part", row.target));
    let meta = meta_path(&dir, &row.target);

    // ---- 断点续传前的体检
    // 1) 清单里记的大小和这次要下的对不上（换了版本）→ 旧断点全部作废
    if let Some(old) = read_meta(&meta) {
        if old.size > 0 && row.size > 0 && old.size != row.size {
            clear_parts(&dir, &row.target);
        }
    }
    // 2) 断点比目标文件还大 → 数据坏了，重来
    let mut have0 = part_bytes(&dir, &row.target);
    if row.size > 0 && have0 > row.size {
        clear_parts(&dir, &row.target);
        have0 = 0;
    }
    // 3) 断点已经等于完整大小 → 上次其实下完了，直接改名收工
    if row.size > 0 && have0 >= row.size && part.exists() {
        if dest.exists() {
            let _ = std::fs::remove_file(&dest);
        }
        if std::fs::rename(&part, &dest).is_ok() {
            let _ = std::fs::remove_file(&meta);
            set_prog(prog, idx, |p| {
                p.status = "完成".into();
                p.received = row.size;
                p.total = row.size;
                p.speed = 0.0;
                p.error.clear();
                p.note.clear();
            });
            return;
        }
    }
    // 记下这次要下什么，下次启动才能认出来接着下
    write_meta(&dir, row);

    set_prog(prog, idx, |p| {
        p.status = "下载中".into();
        p.error.clear();
        if have0 > 0 {
            p.received = have0;
            p.total = if row.size > 0 { row.size } else { have0 };
        }
    });

    let mut last_error = String::new();

    for (ri, (_rname, prefix)) in routes.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            set_prog(prog, idx, |p| p.status = "已取消".into());
            return;
        }
        let full = format!("{}{}", prefix, row.url);
        let ag = dl_agent();

        // 大文件先走多连接分片；不支持或失败时自动退回单连接
        if row.size >= 2 * 1024 * 1024 {
            match download_segmented(
                &row.url,
                routes,
                ri,
                &dir,
                &row.target,
                row.size,
                prog,
                idx,
                cancel,
            ) {
                Ok(_) => {
                    if dest.exists() {
                        let _ = std::fs::remove_file(&dest);
                    }
                    let _ = std::fs::rename(dir.join(format!("{}.part", row.target)), &dest);
                    let _ = std::fs::remove_file(&meta);
                    set_prog(prog, idx, |p| {
                        p.status = "完成".into();
                        p.received = row.size;
                        p.total = row.size;
                        p.speed = 0.0;
                        p.error.clear();
                        p.note.clear();
                    });
                    return;
                }
                Err(e) if e == "CANCELLED" => {
                    set_prog(prog, idx, |p| p.status = "已取消".into());
                    return;
                }
                Err(e) => {
                    if e != "RANGE_SKIP" && e != "RANGE_UNSUPPORTED" {
                        last_error = e;
                    }
                    // 继续往下走单连接流程
                }
            }
        }

        for attempt in 1..=3 {
            let existing = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let mut req = ag.get(&full);
            if existing > 0 {
                req = req.set("Range", &format!("bytes={}-", existing));
            }
            match req.call() {
                Ok(resp) => {
                    let status = resp.status();
                    let len = resp
                        .header("Content-Length")
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    let (start, total) = if status == 206 {
                        (existing, existing + len)
                    } else {
                        (0, len)
                    };
                    let opened = if start > 0 {
                        std::fs::OpenOptions::new().append(true).open(&part)
                    } else {
                        std::fs::File::create(&part)
                    };
                    let mut file = match opened {
                        Ok(f) => f,
                        Err(e) => {
                            last_error = format!("无法写入文件：{}", e);
                            break;
                        }
                    };
                    let mut reader = resp.into_reader();
                    let mut received = start;
                    let mut buf = vec![0u8; 256 * 1024];
                    let mut last_tick = Instant::now();
                    let mut failed = false;

                    loop {
                        if cancel.load(Ordering::SeqCst) {
                            break;
                        }
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                if let Err(e) = file.write_all(&buf[..n]) {
                                    last_error = format!("写入失败：{}", e);
                                    failed = true;
                                    break;
                                }
                                received += n as u64;
                                if last_tick.elapsed() >= Duration::from_millis(250) {
                                    set_prog(prog, idx, |p| {
                                        p.received = received;
                                        p.total = if total > 0 { total } else { received };
                                    });
                                    last_tick = Instant::now();
                                }
                            }
                            Err(e) => {
                                last_error = format!("传输中断：{}", e);
                                failed = true;
                                break;
                            }
                        }
                    }
                    let _ = file.flush();
                    drop(file);

                    if cancel.load(Ordering::SeqCst) {
                        set_prog(prog, idx, |p| p.status = "已取消".into());
                        return;
                    }
                    if failed {
                        continue;
                    }
                    if total > 0 && received < total {
                        last_error = format!("文件不完整：{}/{}", received, total);
                        continue;
                    }
                    if dest.exists() {
                        let _ = std::fs::remove_file(&dest);
                    }
                    let _ = std::fs::rename(&part, &dest);
                    let _ = std::fs::remove_file(&meta);
                    set_prog(prog, idx, |p| {
                        p.status = "完成".into();
                        p.received = received;
                        p.total = if total > 0 { total } else { received };
                        p.speed = 0.0;
                        p.note.clear();
                    });
                    return;
                }
                Err(ureq::Error::Status(code, _)) => {
                    last_error = if code == 404 {
                        "HTTP 404：资源已不存在".to_string()
                    } else if code == 403 {
                        "HTTP 403：访问被拒".to_string()
                    } else {
                        format!("HTTP {}", code)
                    };
                    if code == 404 || code == 410 {
                        // 这条线路给不出文件，换下一条
                        break;
                    }
                }
                Err(e) => {
                    last_error = format!("{}", e);
                }
            }
            if attempt < 3 {
                std::thread::sleep(Duration::from_millis(300 + attempt as u64 * 500));
            }
        }
    }

    // 一个字节都没下到就别留清单，免得下次启动列出一堆 0% 的「未完成」
    if part_bytes(&dir, &row.target) == 0 {
        let _ = std::fs::remove_file(&meta);
    }

    set_prog(prog, idx, |p| {
        p.status = "失败".into();
        p.error = if last_error.is_empty() {
            "所有线路均失败".into()
        } else {
            last_error.clone()
        };
        p.speed = 0.0;
        p.note.clear();
    });
}

fn spawn_download(
    rows: Vec<Row>,
    outdir: String,
    routes: Vec<(String, String)>,
    prog: Arc<Mutex<Vec<FileProg>>>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
) {
    let total = rows.len();
    let rows = Arc::new(rows);
    let routes = Arc::new(routes);
    let cursor = Arc::new(AtomicUsize::new(0));

    {
        let mut p = prog.lock().unwrap();
        p.clear();
        for r in rows.iter() {
            p.push(FileProg {
                asset: r.asset.clone(),
                folder: r.folder.clone(),
                target: r.target.clone(),
                status: "排队中".into(),
                received: 0,
                total: r.size,
                speed: 0.0,
                error: String::new(),
                note: String::new(),
            });
        }
    }

    // 大文件每个都要开 8 条连接，几个一起下就是二十几条连接抢一条宽带，
    // 每条分到的带宽太小，反而更容易被限速拖死。所以有大文件时降并发。
    let big = rows.iter().any(|r| r.size >= 16 * 1024 * 1024);
    let threads = if big { 2 } else { 3 }.min(total.max(1));
    for _ in 0..threads {
        let rows = rows.clone();
        let routes = routes.clone();
        let cursor = cursor.clone();
        let prog = prog.clone();
        let cancel = cancel.clone();
        let outdir = outdir.clone();
        std::thread::spawn(move || loop {
            let i = cursor.fetch_add(1, Ordering::SeqCst);
            if i >= rows.len() {
                break;
            }
            download_one(&rows[i], &outdir, &routes, &prog, &cancel, i);
        });
    }

    // 速度统计 + 结束标志
    std::thread::spawn(move || {
        let mut last: Vec<u64> = vec![0; total];
        let mut last_t = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let dt = last_t.elapsed().as_secs_f64().max(0.05);
            last_t = Instant::now();
            let mut all_finished = true;
            if let Ok(mut v) = prog.lock() {
                for (i, p) in v.iter_mut().enumerate() {
                    let prev = last.get(i).copied().unwrap_or(0);
                    if p.status == "下载中" {
                        p.speed = (p.received.saturating_sub(prev)) as f64 / dt;
                        all_finished = false;
                    } else if p.status == "排队中" {
                        p.speed = 0.0;
                        all_finished = false;
                    } else if p.status == "合并中" {
                        // 合并阶段也是没干完，别在这儿提前判完成
                        p.speed = 0.0;
                        all_finished = false;
                    } else {
                        p.speed = 0.0;
                    }
                    if i < last.len() {
                        last[i] = p.received;
                    }
                }
            }
            if all_finished {
                break;
            }
        }
        done.store(true, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------- 界面

#[derive(Clone, Default)]
struct DoneInfo {
    ok: usize,
    failed: usize,
    outdir: String,
}

struct App {
    repos: String,
    token: String,
    outdir: String,
    latest_only: bool,
    include_pre: bool,

    rows: Vec<Row>,
    errors: Vec<String>,
    scanning: bool,

    routes: Vec<Route>,
    probing: bool,

    prog: Option<Arc<Mutex<Vec<FileProg>>>>,
    cancel: Arc<AtomicBool>,
    job_done: Arc<AtomicBool>,
    job_started: Option<Instant>,
    job_reported: bool,

    status: String,
    show_routes: bool,
    pending_download: bool,
    icon_tex: Option<egui::TextureHandle>,
    /// 引流小卡片的自动关闭时刻（None = 不显示）
    toast_until: Option<Instant>,
    /// 说明浮层：鼠标从何时起停在某条说明上 / 卡片最终摆在哪（固定后不跟着鼠标抖）
    tip_wait: Option<(&'static str, Instant)>,
    tip_pos: Option<egui::Pos2>,
    /// 截图自查用：RO_TIP=pre|token|latest
    tip_force: Option<String>,
    /// 上次没下完的任务（断点续传）
    pending: Vec<(Meta, u64)>,
    show_pending: bool,
    /// 上一次看到的保存目录，用来发现用户换了目录
    outdir_seen: String,
    /// 一轮下载结束后弹出的「是否打开文件夹」询问
    done_info: Option<DoneInfo>,
    demo_start: bool,
    scroll_top: bool,
    demo: bool,

    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        install_fonts(&cc.egui_ctx);
        apply_style(&cc.egui_ctx);
        let (tx, rx) = channel();
        let demo = std::env::var("RO_DEMO").is_ok();
        // 演示/截图时去掉 tooltip 的静止等待，方便把说明框截下来
        if demo {
            cc.egui_ctx.style_mut(|s| {
                s.interaction.tooltip_delay = 0.0;
                s.interaction.show_tooltips_only_when_still = false;
            });
        }
        let icon_tex = Some(cc.egui_ctx.load_texture(
            "app-icon",
            egui::ColorImage::from_rgba_unmultiplied(
                [256, 256],
                include_bytes!("../assets/icon.rgba").as_slice(),
            ),
            egui::TextureOptions::NEAREST,
        ));
        let outdir = if let Ok(p) = std::env::var("RO_OUTDIR") {
            // 自测/截图时用指定目录
            p
        } else if demo {
            // 演示/自测时落到临时目录，避免污染真实桌面
            std::env::temp_dir()
                .join("release-organizer-demo")
                .to_string_lossy()
                .to_string()
        } else {
            default_outdir()
        };
        // 启动先看一眼保存目录里有没有上次没下完的，有就在列表上方给「继续下载」
        let pending = scan_pending(&outdir);
        let outdir_dbg = outdir.clone();
        let has_pending = !pending.is_empty();
        let status = if has_pending {
            format!(
                "上次有 {} 个文件没下完，点上方「继续下载」接着下。",
                pending.len()
            )
        } else {
            "填入仓库地址后点「扫描 Release」。".into()
        };
        // 截图自查用：RO_FAKE=1 摆一个「正在下载」的进度快照，
        // 免得每次都要真跑一遍下载才能看到底部总速度、状态列这些。
        let fake = std::env::var("RO_FAKE").ok();
        Self {
            repos: if demo {
                "sharkdp/bat\nmicrosoft/PowerToys".to_string()
            } else {
                String::new()
            },
            token: String::new(),
            outdir,
            latest_only: true,
            include_pre: true,
            rows: Vec::new(),
            errors: Vec::new(),
            scanning: false,
            routes: Vec::new(),
            probing: false,
            prog: fake.as_ref().map(|k| fake_prog(k)),
            cancel: Arc::new(AtomicBool::new(false)),
            job_done: Arc::new(AtomicBool::new(fake.is_none())),
            job_started: fake
                .as_ref()
                .map(|_| Instant::now() - Duration::from_secs(32)),
            job_reported: true,
            status,
            show_routes: false,
            pending_download: false,
            icon_tex,
            toast_until: None,
            tip_wait: None,
            tip_pos: None,
            tip_force: std::env::var("RO_TIP").ok(),
            pending,
            show_pending: has_pending,
            outdir_seen: outdir_dbg.clone(),
            done_info: if std::env::var("RO_DIALOG").is_ok() {
                // 截图自查用：直接摆出「下载完成」询问框
                Some(DoneInfo {
                    ok: 3,
                    failed: 0,
                    outdir: outdir_dbg.clone(),
                })
            } else {
                None
            },
            demo_start: demo,
            scroll_top: false,
            demo,
            tx,
            rx,
        }
    }

    fn start_scan(&mut self, ctx: &egui::Context) {
        let mut repos: Vec<String> = Vec::new();
        for line in self.repos.lines() {
            let n = normalize_repo(line);
            if !n.is_empty() && !repos.contains(&n) {
                repos.push(n);
            }
        }
        if repos.is_empty() {
            self.errors = vec!["请至少填写一个仓库，格式 owner/repo".into()];
            return;
        }
        self.scanning = true;
        self.errors.clear();
        self.rows.clear();
        self.status = format!("正在读取 {} 个仓库的 Release…", repos.len());

        let tx = self.tx.clone();
        let token = self.token.trim().to_string();
        let include_pre = self.include_pre;
        let latest_only = self.latest_only;
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let (rows, errors) = scan_repos(&repos, &token, include_pre, latest_only);
            let _ = tx.send(Msg::Scan(rows, errors));
            ctx.request_repaint();
        });
    }

    fn start_probe(&mut self, ctx: &egui::Context) {
        // 用体积最大的那个文件来测速，更能反映真实吞吐
        let url = match self.rows.iter().max_by_key(|r| r.size) {
            Some(r) => r.url.clone(),
            None => return,
        };
        self.probing = true;
        self.status = "正在测试各条线路的速度…".into();
        let tx = self.tx.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let routes = probe_routes(&url);
            let _ = tx.send(Msg::Routes(routes));
            ctx.request_repaint();
        });
    }

    fn route_pairs(&self) -> Vec<(String, String)> {
        let mut list: Vec<Route> = self.routes.iter().filter(|r| r.ok).cloned().collect();
        if list.is_empty() {
            return ROUTE_LIST
                .iter()
                .map(|(n, p)| (n.to_string(), p.to_string()))
                .collect();
        }
        list.sort_by(|a, b| {
            b.speed
                .partial_cmp(&a.speed)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        list.into_iter().map(|r| (r.name, r.prefix)).collect()
    }

    fn start_download(&mut self) {
        // 选中的文件排到最前面，下载进度就在第一屏，不用滚动去找
        self.refresh_resume();
        self.rows.sort_by_key(|r| !r.selected);
        self.scroll_top = true;
        let selected: Vec<Row> = self.rows.iter().filter(|r| r.selected).cloned().collect();
        if selected.is_empty() {
            self.errors = vec!["请至少勾选一个文件".into()];
            return;
        }
        if let Err(e) = std::fs::create_dir_all(&self.outdir) {
            self.errors = vec![format!("输出目录不可写：{}", e)];
            return;
        }
        self.errors.clear();
        self.cancel = Arc::new(AtomicBool::new(false));
        self.job_done = Arc::new(AtomicBool::new(false));
        let prog = Arc::new(Mutex::new(Vec::new()));
        self.prog = Some(prog.clone());
        self.job_started = Some(Instant::now());
        self.job_reported = false;
        let resumed: Vec<&Row> = selected.iter().filter(|r| r.resume > 0).collect();
        let resume_bytes: u64 = resumed.iter().map(|r| r.resume).sum();
        self.status = if resume_bytes > 0 {
            format!(
                "开始下载 {} 个文件，其中 {} 个从断点续传（已下 {}）…",
                selected.len(),
                resumed.len(),
                fmt_size(resume_bytes)
            )
        } else {
            format!("开始下载 {} 个文件…", selected.len())
        };
        // 下载一开始就浮出小卡片，8 秒后自己收起来
        self.toast_until = Some(Instant::now() + Duration::from_secs(8));

        let routes = self.route_pairs();
        spawn_download(
            selected,
            self.outdir.clone(),
            routes,
            prog,
            self.cancel.clone(),
            self.job_done.clone(),
        );
    }

    /// 重新统计每个文件在磁盘上的断点字节数（换目录、下载结束后都要刷一次）
    fn refresh_resume(&mut self) {
        let root = PathBuf::from(&self.outdir);
        for r in self.rows.iter_mut() {
            if r.repo.is_empty() || r.folder.is_empty() {
                r.resume = 0;
                continue;
            }
            let dir = root.join(repo_short(&r.repo)).join(&r.folder);
            let have = part_bytes(&dir, &r.target);
            r.resume = if r.size > 0 {
                have.min(r.size)
            } else {
                have
            };
        }
    }

    /// 接着上次的断点下：把未完成任务直接变成这次的文件列表
    fn start_resume(&mut self) {
        let items = std::mem::take(&mut self.pending);
        let mut rows: Vec<Row> = Vec::new();
        for (m, have) in items {
            rows.push(Row {
                repo: m.repo,
                tag: String::new(),
                asset: m.asset,
                folder: m.folder,
                arch: String::new(),
                size: m.size,
                url: m.url,
                target: m.target,
                selected: true,
                resume: have,
            });
        }
        if rows.is_empty() {
            self.show_pending = false;
            return;
        }
        self.show_pending = false;
        self.rows = rows;
        self.status = format!("继续下载 {} 个未完成的文件…", self.rows.len());
        self.start_download();
    }

    /// 丢弃所有断点（用户主动清场）
    fn drop_pending(&mut self) {
        let root = PathBuf::from(&self.outdir);
        for (m, _) in std::mem::take(&mut self.pending) {
            let dir = root.join(repo_short(&m.repo)).join(&m.folder);
            clear_parts(&dir, &m.target);
            let _ = std::fs::remove_file(meta_path(&dir, &m.target));
        }
        self.show_pending = false;
        self.refresh_resume();
        self.status = "已清理断点，下次重新开始下载。".into();
    }

    fn progress_snapshot(&self) -> Option<Vec<FileProg>> {
        self.prog
            .as_ref()
            .and_then(|p| p.lock().ok().map(|v| v.clone()))
    }

    fn selected_count(&self) -> usize {
        self.rows.iter().filter(|r| r.selected).count()
    }

    fn overall(&self) -> (usize, usize, f32) {
        match self.progress_snapshot() {
            Some(s) => {
                let total = s.len();
                let done = s
                    .iter()
                    .filter(|p| p.status == "完成" || p.status == "失败" || p.status == "已取消")
                    .count();
                let frac = if total > 0 {
                    done as f32 / total as f32
                } else {
                    0.0
                };
                (done, total, frac)
            }
            None => (0, 0, 0.0),
        }
    }

    /// 所有任务已下载字节之和
    fn received_all(&self) -> u64 {
        self.progress_snapshot()
            .map(|s| s.iter().map(|p| p.received).sum())
            .unwrap_or(0)
    }
}

fn default_outdir() -> String {
    // 默认放桌面；取不到桌面就退回程序所在目录
    if let Ok(home) = std::env::var("USERPROFILE") {
        let desktop = PathBuf::from(&home).join("Desktop");
        if desktop.is_dir() {
            return desktop.to_string_lossy().to_string();
        }
        let one_drive = PathBuf::from(&home).join("OneDrive").join("Desktop");
        if one_drive.is_dir() {
            return one_drive.to_string_lossy().to_string();
        }
        if PathBuf::from(&home).is_dir() {
            return home;
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.to_string_lossy().to_string()
}

/// 弹出系统文件夹选择框
#[cfg(target_os = "windows")]
fn pick_folder() -> Option<String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };

    let title: Vec<u16> = "选择下载保存位置\0".encode_utf16().collect();
    let mut display = [0u16; 260];
    let mut out = None;
    unsafe {
        let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let mut bi: BROWSEINFOW = std::mem::zeroed();
        bi.hwndOwner = std::ptr::null_mut();
        bi.pidlRoot = std::ptr::null_mut();
        bi.pszDisplayName = display.as_mut_ptr();
        bi.lpszTitle = title.as_ptr();
        bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
        let pidl = SHBrowseForFolderW(&bi);
        if !pidl.is_null() {
            let mut buf = [0u16; 260];
            if SHGetPathFromIDListW(pidl, buf.as_mut_ptr()) != 0 {
                let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
                out = Some(String::from_utf16_lossy(&buf[..len]));
            }
            CoTaskMemFree(pidl as *const core::ffi::c_void);
        }
        if hr >= 0 {
            CoUninitialize();
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn pick_folder() -> Option<String> {
    None
}

/// 自定义「粗体家族」名字：给标题与按钮用更厚实的字重
const FONT_BOLD: &str = "px-bold";

fn bold_family() -> egui::FontFamily {
    egui::FontFamily::Name(FONT_BOLD.into())
}

/// 粗体字（用于标题、按钮、数字）
fn px(size: f32) -> egui::FontId {
    egui::FontId::new(size, bold_family())
}

/// 常规字（用于正文、说明）
fn pr(size: f32) -> egui::FontId {
    egui::FontId::new(size, egui::FontFamily::Proportional)
}

fn install_fonts(ctx: &egui::Context) {
    // 正文：MiSans（几何现代）→ 等线 → 黑体 → 雅黑；粗体再单独挂一套
    let regular = [
        "C:/Windows/Fonts/MiSans-Regular.ttf",
        "C:/Windows/Fonts/Deng.ttf",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
    ];
    let heavy = [
        "C:/Windows/Fonts/MiSans-Demibold.ttf",
        "C:/Windows/Fonts/MiSans-Semibold.ttf",
        "C:/Windows/Fonts/Dengb.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
    ];

    let mut fonts = egui::FontDefinitions::default();
    let mut has_body = false;
    for path in regular {
        if let Ok(bytes) = std::fs::read(path) {
            fonts
                .font_data
                .insert("body".to_owned(), egui::FontData::from_owned(bytes));
            for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                fonts
                    .families
                    .entry(family)
                    .or_default()
                    .insert(0, "body".to_owned());
            }
            has_body = true;
            break;
        }
    }

    // 粗体家族：找不到粗体时退化成正文家族，保证 FontId 一定存在
    let mut fam: Vec<String> = Vec::new();
    for path in heavy {
        if let Ok(bytes) = std::fs::read(path) {
            fonts
                .font_data
                .insert("heavy".to_owned(), egui::FontData::from_owned(bytes));
            fam.push("heavy".to_owned());
            break;
        }
    }
    if let Some(list) = fonts.families.get(&egui::FontFamily::Proportional).cloned() {
        fam.extend(list);
    }
    if fam.is_empty() {
        fam.push("body".to_owned());
    }
    fonts.families.insert(bold_family(), fam);
    let _ = has_body;
    ctx.set_fonts(fonts);
}

/// 无界面自检：扫描 → 线路测速 → 下载，用于发布前验证
fn selftest() {
    let out = PathBuf::from("_selftest_out");
    let _ = std::fs::create_dir_all(&out);

    println!("[1/3] 扫描 sharkdp/bat …");
    let repos = vec!["sharkdp/bat".to_string()];
    let (rows, errors) = scan_repos(&repos, "", false, true);
    println!("  文件数={} 错误={:?}", rows.len(), errors);
    for r in rows.iter().take(3) {
        println!("  - {}  ->  {}", r.asset, r.target);
    }
    if rows.is_empty() {
        println!("扫描为空，终止");
        return;
    }

    println!("[2/3] 线路测速 …");
    let routes = probe_routes(&rows[0].url);
    let mut sorted = routes.clone();
    sorted.sort_by(|a, b| {
        b.speed
            .partial_cmp(&a.speed)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for r in &sorted {
        println!("  {:<14} ok={:<5} {}", r.name, r.ok, fmt_speed(r.speed));
    }

    println!("[3/3] 下载 2 个文件 …");
    let mut pairs: Vec<(String, String)> = sorted
        .iter()
        .filter(|r| r.ok)
        .map(|r| (r.name.clone(), r.prefix.clone()))
        .collect();
    if pairs.is_empty() {
        pairs.push(("直连".to_string(), String::new()));
    }

    let sel: Vec<Row> = rows.iter().take(2).cloned().collect();
    let prog = Arc::new(Mutex::new(Vec::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    spawn_download(
        sel,
        out.to_string_lossy().to_string(),
        pairs,
        prog.clone(),
        cancel,
        done.clone(),
    );
    let t0 = Instant::now();
    while !done.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(150) {
        std::thread::sleep(Duration::from_millis(300));
    }
    if let Ok(v) = prog.lock() {
        for p in v.iter() {
            println!(
                "  {} | {} | {}/{} | {}",
                p.status, p.folder, p.received, p.total, p.error
            );
        }
    }
    println!("自检结束，用时 {} 秒", t0.elapsed().as_secs());
}

fn open_path(path: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
}

/// 用系统默认浏览器打开网址
fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

/// 无窗口校验中文字形是否可用（排查「界面显示方块」用）
fn font_check() {
    let ctx = egui::Context::default();
    install_fonts(&ctx);
    ctx.begin_pass(egui::RawInput::default());
    let sample = "下载整理工具仓库扫描选择线路测速开始完成失败放弃已选文件大小保存目录";
    for (name, id) in [
        ("常规", pr(15.0)),
        ("粗体", px(15.0)),
    ] {
        let ok = ctx.fonts(|f| f.has_glyphs(&id, sample));
        let missing: String = sample
            .chars()
            .filter(|c| !ctx.fonts(|f| f.has_glyph(&id, *c)))
            .collect();
        println!("[{}] 中文字形可用: {} 缺失: [{}]", name, ok, missing);
    }
}

fn apply_style(ctx: &egui::Context) {
    let mut v = egui::Visuals::light();
    v.override_text_color = Some(TEXT);
    v.panel_fill = BG;
    v.window_fill = PAPER;
    // 输入区域底色（暖白，配米色底）
    v.extreme_bg_color = egui::Color32::from_rgb(255, 249, 236);
    v.faint_bg_color = egui::Color32::from_rgb(255, 247, 231);
    v.selection.bg_fill = egui::Color32::from_rgb(255, 214, 130);
    v.selection.stroke = egui::Stroke::new(2.0, INK);
    v.widgets.noninteractive.bg_stroke = egui::Stroke::new(2.0, INK);
    v.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.5, TEXT);
    // 未交互：白纸底 + 墨线描边
    v.widgets.inactive.bg_fill = PAPER;
    v.widgets.inactive.weak_bg_fill = SOFT;
    v.widgets.inactive.bg_stroke = egui::Stroke::new(2.0, INK);
    v.widgets.inactive.fg_stroke = egui::Stroke::new(1.5, TEXT);
    // 悬停：蜜瓜色
    v.widgets.hovered.bg_fill = egui::Color32::from_rgb(255, 244, 222);
    v.widgets.hovered.weak_bg_fill = egui::Color32::from_rgb(255, 244, 222);
    v.widgets.hovered.bg_stroke = egui::Stroke::new(2.5, INK);
    v.widgets.hovered.fg_stroke = egui::Stroke::new(1.5, TEXT);
    // 按下
    v.widgets.active.bg_fill = egui::Color32::from_rgb(255, 226, 190);
    v.widgets.active.weak_bg_fill = egui::Color32::from_rgb(255, 226, 190);
    v.widgets.active.bg_stroke = egui::Stroke::new(2.5, INK);
    v.widgets.active.fg_stroke = egui::Stroke::new(1.5, INK);
    v.window_stroke = egui::Stroke::new(2.5, INK);
    v.window_rounding = egui::Rounding::same(0.0);
    v.menu_rounding = egui::Rounding::same(0.0);
    // 说明浮层也用像素风：硬直角 + 不要柔和投影
    v.popup_shadow = egui::epaint::Shadow::NONE;
    v.window_shadow = egui::epaint::Shadow::NONE;
    ctx.set_visuals(v);

    let mut s = (*ctx.style()).clone();
    // 字号整体上调，标题与按钮用粗体家族
    s.text_styles = [
        (
            egui::TextStyle::Heading,
            egui::FontId::new(22.0, bold_family()),
        ),
        (egui::TextStyle::Body, pr(15.0)),
        (egui::TextStyle::Monospace, egui::FontId::new(14.0, egui::FontFamily::Monospace)),
        (egui::TextStyle::Button, px(16.0)),
        (egui::TextStyle::Small, pr(13.0)),
    ]
    .into();

    s.spacing.item_spacing = egui::vec2(10.0, 10.0);
    s.spacing.button_padding = egui::vec2(14.0, 9.0);
    s.spacing.interact_size.y = 30.0;
    s.spacing.scroll = egui::style::ScrollStyle::solid();
    s.spacing.scroll.bar_width = 12.0;
    s.spacing.scroll.bar_inner_margin = 3.0;
    s.spacing.scroll.bar_outer_margin = 3.0;
    s.spacing.scroll.handle_min_length = 30.0;
    s.spacing.scroll.floating = false;
    s.visuals.widgets.inactive.fg_stroke.color = TEXT;
    // 表格斑马纹：极浅的米色
    s.visuals.striped = true;
    ctx.set_style(s);
}

// ---------------------------------------------------------------- 界面绘制

// ---------------------------------------------------------------- 像素风设计系统

const INK: egui::Color32 = egui::Color32::from_rgb(26, 30, 48);
const CREAM: egui::Color32 = egui::Color32::from_rgb(255, 243, 220);
const PAPER: egui::Color32 = egui::Color32::from_rgb(255, 253, 247);
const CORAL: egui::Color32 = egui::Color32::from_rgb(255, 106, 61);
const CORAL_HI: egui::Color32 = egui::Color32::from_rgb(255, 139, 100);
const MINT: egui::Color32 = egui::Color32::from_rgb(46, 211, 165);
const SUN: egui::Color32 = egui::Color32::from_rgb(255, 201, 60);

const BG: egui::Color32 = CREAM;
const TEXT: egui::Color32 = INK;
const TEXT2: egui::Color32 = egui::Color32::from_rgb(138, 122, 100);
const SOFT: egui::Color32 = egui::Color32::from_rgb(255, 240, 214);
/// 像素风的「错位实心影子」距离
const SH: f32 = 5.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum BtnKind {
    Primary,
    Ghost,
    Danger,
}

/// 像素卡片：白纸底 + 3px 墨线硬边 + 右下错位实心影子
fn pixel_card<R>(ui: &mut egui::Ui, pad: egui::Vec2, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let idx = ui.painter().add(egui::Shape::Noop);
    let inner = egui::Frame::none()
        .fill(PAPER)
        .stroke(egui::Stroke::new(3.0, INK))
        .rounding(egui::Rounding::same(0.0))
        .inner_margin(egui::Margin::symmetric(pad.x, pad.y))
        .show(ui, add);
    let r = inner.response.rect;
    let shadow = egui::Rect::from_min_max(r.min + egui::vec2(SH, SH), r.max + egui::vec2(SH, SH));
    ui.painter().set(
        idx,
        egui::Shape::rect_filled(shadow, egui::Rounding::same(0.0), INK),
    );
    inner.inner
}

/// 自绘像素按钮：硬直角 + 墨线描边 + 按下位移
fn pixel_button(
    ui: &mut egui::Ui,
    text: &str,
    w: f32,
    h: f32,
    kind: BtnKind,
    enabled: bool,
) -> egui::Response {
    let fs = (h * 0.40).clamp(14.0, 19.0);
    let body_w = if w <= 0.0 {
        let tw = ui.fonts(|f| {
            f.layout_no_wrap(text.to_owned(), px(fs), TEXT)
                .size()
                .x
        });
        tw + 30.0
    } else {
        w
    };
    let (outer, resp) = ui.allocate_exact_size(
        egui::vec2(body_w + SH, h + SH),
        if enabled {
            egui::Sense::click()
        } else {
            egui::Sense::hover()
        },
    );
    let hovered = enabled && resp.hovered();
    let down = enabled && resp.is_pointer_button_down_on();
    let press = if down { 3.0 } else { 0.0 };

    let (fill, fg, stroke) = if !enabled {
        (
            egui::Color32::from_rgb(242, 222, 206),
            egui::Color32::from_rgb(158, 138, 122),
            egui::Stroke::new(2.5, egui::Color32::from_rgb(196, 176, 158)),
        )
    } else {
        match kind {
            BtnKind::Primary => (
                if hovered { CORAL_HI } else { CORAL },
                egui::Color32::WHITE,
                egui::Stroke::new(3.0, INK),
            ),
            BtnKind::Ghost => (
                if hovered { SUN } else { PAPER },
                INK,
                egui::Stroke::new(2.5, INK),
            ),
            BtnKind::Danger => (PAPER, CORAL, egui::Stroke::new(2.5, INK)),
        }
    };

    let body = egui::Rect::from_min_size(
        outer.min + egui::vec2(press, press),
        egui::vec2(body_w, h),
    );
    let p = ui.painter();
    if enabled {
        let sh = egui::Rect::from_min_size(body.min + egui::vec2(SH - press, SH - press), body.size());
        p.rect_filled(sh, egui::Rounding::same(0.0), INK);
    }
    p.rect(body, egui::Rounding::same(0.0), fill, stroke);
    p.text(
        body.center(),
        egui::Align2::CENTER_CENTER,
        text,
        px(fs),
        fg,
    );
    if hovered {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

fn field_label(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).font(px(14.0)).color(TEXT2));
}

/// 像素风关闭按钮：20×20 小方块 + 墨线 X，
fn close_x(ui: &mut egui::Ui) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(20.0, 20.0), egui::Sense::click());
    let hov = resp.hovered();
    let p = ui.painter();
    p.rect(
        rect,
        egui::Rounding::same(0.0),
        if hov { CORAL } else { PAPER },
        egui::Stroke::new(2.5, INK),
    );
    let c = rect.center();
    let col = if hov {
        egui::Color32::WHITE
    } else {
        INK
    };
    let d = 4.0;
    p.line_segment(
        [
            egui::pos2(c.x - d, c.y - d),
            egui::pos2(c.x + d, c.y + d),
        ],
        egui::Stroke::new(2.5, col),
    );
    p.line_segment(
        [
            egui::pos2(c.x + d, c.y - d),
            egui::pos2(c.x - d, c.y + d),
        ],
        egui::Stroke::new(2.5, col),
    );
    if hov {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

/// 带说明的字段标签：底部一排 3px 小方块作为「可悬停」暗示
fn field_label_tip(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let font = px(14.0);
    let tw = ui.fonts(|f| {
        f.layout_no_wrap(text.to_owned(), font.clone(), TEXT2)
            .size()
            .x
    });
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(tw + 2.0, 32.0), egui::Sense::hover());
    let p = ui.painter();
    p.text(
        egui::pos2(rect.left(), rect.center().y - 2.0),
        egui::Align2::LEFT_CENTER,
        text,
        font,
        TEXT2,
    );
    let y = rect.center().y + 10.0;
    let mut x = rect.left();
    while x + 3.0 <= rect.left() + tw {
        p.rect_filled(
            egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(3.0, 2.5)),
            egui::Rounding::same(0.0),
            TEXT2,
        );
        x += 6.0;
    }
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Help);
    }
    resp
}

/// 小节标题：珊瑚色像素方块 + 粗体标题
fn section_title(ui: &mut egui::Ui, text: &str, hint: &str) {
    ui.horizontal(|ui| {
        let (r, _) = ui.allocate_exact_size(egui::vec2(11.0, 11.0), egui::Sense::hover());
        ui.painter().rect_filled(r, egui::Rounding::same(0.0), CORAL);
        ui.add_space(2.0);
        ui.label(egui::RichText::new(text).font(px(17.0)).color(INK));
        if !hint.is_empty() {
            ui.add_space(6.0);
            ui.label(egui::RichText::new(hint).font(pr(13.5)).color(TEXT2));
        }
    });
}

/// 自绘像素复选框（带可点击文字）
fn check_row(ui: &mut egui::Ui, checked: &mut bool, label: &str) -> egui::Response {
    let font = px(15.0);
    let box_s = 20.0;
    let text_w = if label.is_empty() {
        0.0
    } else {
        ui.fonts(|f| {
            f.layout_no_wrap(label.to_owned(), font.clone(), TEXT)
                .size()
                .x
        })
    };
    let w = box_s + if label.is_empty() { 0.0 } else { 9.0 + text_w };
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(w, 28.0), egui::Sense::click());
    let b = egui::Rect::from_min_size(
        egui::pos2(rect.left(), rect.center().y - box_s / 2.0),
        egui::vec2(box_s, box_s),
    );
    let p = ui.painter();
    p.rect_filled(
        egui::Rect::from_min_size(b.min + egui::vec2(3.0, 3.0), b.size()),
        egui::Rounding::same(0.0),
        egui::Color32::from_rgb(228, 208, 180),
    );
    if *checked {
        p.rect(b, egui::Rounding::same(0.0), CORAL, egui::Stroke::new(2.5, INK));
        let c = b.center();
        p.add(egui::Shape::line(
            vec![
                egui::pos2(c.x - 5.0, c.y + 0.2),
                egui::pos2(c.x - 1.4, c.y + 4.0),
                egui::pos2(c.x + 5.4, c.y - 4.2),
            ],
            egui::Stroke::new(3.2, egui::Color32::WHITE),
        ));
    } else {
        p.rect(
            b,
            egui::Rounding::same(0.0),
            PAPER,
            egui::Stroke::new(2.5, INK),
        );
    }
    if !label.is_empty() {
        p.text(
            egui::pos2(b.right() + 9.0, rect.center().y),
            egui::Align2::LEFT_CENTER,
            label,
            font,
            TEXT,
        );
    }
    if resp.clicked() {
        *checked = !*checked;
    }
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

/// 悬停说明：标题 + 正文
#[derive(Clone, Copy)]
struct Tip {
    title: &'static str,
    body: &'static str,
    anchor: egui::Rect,
}

/// 估算说明浮层高度，用于判断下方空间够不够
fn tip_est_height(body: &str) -> f32 {
    let lines = body.lines().count().max(1) as f32;
    lines * 21.0 + 62.0 + body.matches("\n\n").count() as f32 * 4.0
}

/// 自绘说明浮层（不依赖 egui 的 tooltip 状态机，位置和外观都可控）
fn show_tip(ctx: &egui::Context, tip: Tip, pos: egui::Pos2) {
    let w = 400.0;
    egui::Area::new(egui::Id::new("hover-tip"))
        .order(egui::Order::Tooltip)
        .fixed_pos(pos)
        .interactable(false)
        .show(ctx, |ui| {
            ui.set_max_width(w);
            pixel_card(ui, egui::vec2(14.0, 11.0), |ui| {
                ui.set_max_width(w - 32.0);
                ui.horizontal(|ui| {
                    let (r, _) =
                        ui.allocate_exact_size(egui::vec2(9.0, 9.0), egui::Sense::hover());
                    ui.painter()
                        .rect_filled(r, egui::Rounding::same(0.0), CORAL);
                    ui.add_space(1.0);
                    ui.label(egui::RichText::new(tip.title).font(px(15.5)).color(INK));
                });
                ui.add_space(7.0);
                for line in tip.body.lines() {
                    if line.trim().is_empty() {
                        ui.add_space(4.0);
                        continue;
                    }
                    // 数字/符号开头的是步骤行，用粗体突出
                    let is_step = line
                        .trim_start()
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_digit() || c == '·' || c == '✓' || c == '-')
                        .unwrap_or(false);
                    ui.label(
                        egui::RichText::new(line)
                            .font(if is_step { px(13.5) } else { pr(13.5) })
                            .color(if is_step { TEXT } else { TEXT2 }),
                    );
                }
            });
        });
}

/// 带悬停说明的复选框
fn check_row_tip(
    ui: &mut egui::Ui,
    checked: &mut bool,
    label: &str,
    title: &'static str,
    body: &'static str,
    out: &mut Option<Tip>,
) {
    let resp = check_row(ui, checked, label);
    if resp.hovered() {
        *out = Some(Tip {
            title,
            body,
            anchor: resp.rect,
        });
    }
}

/// 分段像素进度条
fn bar(ui: &mut egui::Ui, frac: f32, width: f32, height: f32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(width, height), egui::Sense::hover());
    let p = ui.painter();
    p.rect(
        rect,
        egui::Rounding::same(0.0),
        egui::Color32::from_rgb(255, 236, 208),
        egui::Stroke::new(2.0, INK),
    );
    let inner = rect.shrink(3.0);
    if inner.width() <= 4.0 || inner.height() <= 2.0 {
        return;
    }
    let gap = 2.0;
    let seg = 9.0;
    let n = (((inner.width() + gap) / (seg + gap)).floor() as usize).max(1);
    let total_w = n as f32 * seg + (n as f32 - 1.0) * gap;
    let x0 = inner.center().x - total_w / 2.0;
    let f = frac.clamp(0.0, 1.0);
    let lit = (f * n as f32).round() as usize;
    for i in 0..n {
        let x = x0 + i as f32 * (seg + gap);
        let r = egui::Rect::from_min_size(
            egui::pos2(x, inner.top()),
            egui::vec2(seg, inner.height()),
        );
        let col = if i < lit {
            if f >= 0.999 {
                MINT
            } else {
                CORAL
            }
        } else {
            // 未完成段与轨道同色，避免出现「梯子」状花纹
            egui::Color32::from_rgb(255, 236, 208)
        };
        p.rect_filled(r, egui::Rounding::same(0.0), col);
    }
}

/// 带墨线边框的输入框容器
fn input_box(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .fill(egui::Color32::from_rgb(255, 249, 236))
        .stroke(egui::Stroke::new(2.5, INK))
        .rounding(egui::Rounding::same(0.0))
        .inner_margin(egui::Margin::symmetric(11.0, 8.0))
        .show(ui, add);
}

fn pill(ui: &mut egui::Ui, text: &str, fg: egui::Color32, bg: egui::Color32) {
    let font = px(13.0);
    let tw = ui.fonts(|f| {
        f.layout_no_wrap(text.to_owned(), font.clone(), fg)
            .size()
            .x
    });
    let (rect, _) = ui.allocate_exact_size(egui::vec2(tw + 18.0, 26.0), egui::Sense::hover());
    let p = ui.painter();
    p.rect(
        rect,
        egui::Rounding::same(0.0),
        bg,
        egui::Stroke::new(2.0, INK),
    );
    p.text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        text,
        font,
        fg,
    );
}

fn platform_badge(ui: &mut egui::Ui, folder: &str) {
    match folder {
        "Windows" => pill(
            ui,
            "Windows",
            egui::Color32::from_rgb(26, 84, 190),
            egui::Color32::from_rgb(214, 232, 255),
        ),
        "macOS" => pill(
            ui,
            "macOS",
            egui::Color32::from_rgb(10, 128, 100),
            egui::Color32::from_rgb(206, 245, 232),
        ),
        _ => pill(ui, "其他", TEXT2, SOFT),
    }
}

/// 可点击的像素小标签（顶部线路状态用）
fn chip(
    ui: &mut egui::Ui,
    text: &str,
    fg: egui::Color32,
    bg: egui::Color32,
) -> egui::Response {
    let font = px(13.5);
    let tw = ui.fonts(|f| {
        f.layout_no_wrap(text.to_owned(), font.clone(), fg)
            .size()
            .x
    });
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(tw + 24.0, 32.0), egui::Sense::click());
    let body = egui::Rect::from_min_size(rect.min, rect.size() - egui::vec2(3.0, 3.0));
    let p = ui.painter();
    p.rect_filled(
        egui::Rect::from_min_size(body.min + egui::vec2(3.0, 3.0), body.size()),
        egui::Rounding::same(0.0),
        INK,
    );
    p.rect(
        body,
        egui::Rounding::same(0.0),
        if resp.hovered() { SUN } else { bg },
        egui::Stroke::new(2.5, INK),
    );
    p.text(body.center(), egui::Align2::CENTER_CENTER, text, font, fg);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

impl App {
    fn best_route(&self) -> Option<Route> {
        self.routes
            .iter()
            .filter(|r| r.ok)
            .max_by(|a, b| {
                a.speed
                    .partial_cmp(&b.speed)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()
    }

    /// 说明浮层摆在哪：鼠标右下方，靠边时自动翻到左侧/上方
    fn tip_position(&self, ctx: &egui::Context, tip: Tip) -> egui::Pos2 {
        let screen = ctx.screen_rect();
        let w = 400.0;
        let pointer = ctx
            .input(|i| i.pointer.hover_pos())
            .unwrap_or_else(|| tip.anchor.center());
        let mut pos = pointer + egui::vec2(16.0, 22.0);
        if pos.x + w > screen.right() - 12.0 {
            pos.x = (pointer.x - w - 16.0).max(screen.left() + 12.0);
        }
        let h = tip_est_height(tip.body);
        if pos.y + h > screen.bottom() - 12.0 {
            pos.y = (pointer.y - h - 16.0).max(screen.top() + 12.0);
        }
        pos
    }

    /// 下载开始时浮现的小卡片：软件 logo + 领取积分 + 更多黑科技内容，停留几秒自动收起
    fn draw_promo(&mut self, ctx: &egui::Context) {
        let Some(until) = self.toast_until else {
            return;
        };
        let now = Instant::now();
        if now >= until {
            self.toast_until = None;
            return;
        }
        // 剩余不足 1 秒时，顶部那条红色倒计时进度会自然走完，给一个「要关了」的预期
        let remain = (until - now).as_secs_f32();
        let total = 8.0f32;
        let icon_id = self.icon_tex.as_ref().map(|t| t.id());

        let mut goto: Option<&'static str> = None;
        let mut close = false;

        egui::Area::new(egui::Id::new("promo-card"))
            .order(egui::Order::Foreground)
            .anchor(egui::Align2::RIGHT_BOTTOM, egui::vec2(-26.0, -104.0))
            .show(ctx, |ui| {
                pixel_card(ui, egui::vec2(15.0, 12.0), |ui| {
                    // 固定宽度，否则末尾的右对齐布局会把卡片撑到整块可用宽度
                    ui.set_width(342.0);
                    // 顶部倒计时条：剩下的时间直接可视化，收起了也不会显得突然
                    let bar_w = ui.available_width();
                    let (tr, _) = ui.allocate_exact_size(egui::vec2(bar_w, 4.0), egui::Sense::hover());
                    let p = ui.painter();
                    p.rect_filled(tr, egui::Rounding::same(0.0), SOFT);
                    let mut on = tr;
                    on.set_width(tr.width() * (remain / total).clamp(0.0, 1.0));
                    p.rect_filled(on, egui::Rounding::same(0.0), CORAL);
                    ui.add_space(9.0);

                    ui.horizontal(|ui| {
                        if let Some(id) = icon_id {
                            ui.add(egui::Image::new(egui::load::SizedTexture::new(
                                id,
                                egui::vec2(32.0, 32.0),
                            )));
                            ui.add_space(3.0);
                        }
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new("本软件由 AI 工具免费制作")
                                    .font(px(14.5))
                                    .color(INK),
                            );
                            ui.label(
                                egui::RichText::new("每日可领 5000 积分，同款工具自己也能做")
                                    .font(pr(12.5))
                                    .color(TEXT2),
                            );
                        });
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if close_x(ui).clicked() {
                                    close = true;
                                }
                            },
                        );
                    });

                    ui.add_space(11.0);
                    ui.horizontal(|ui| {
                        if pixel_button(ui, "领取积分", 108.0, 32.0, BtnKind::Primary, true)
                            .clicked()
                        {
                            goto = Some(PROMO_URL);
                        }
                        ui.add_space(2.0);
                        if pixel_button(ui, "更多黑科技内容 →", 0.0, 32.0, BtnKind::Ghost, true)
                            .clicked()
                        {
                            goto = Some(MORE_URL);
                        }
                    });
                });
            });

        if let Some(url) = goto {
            open_url(url);
            self.toast_until = None;
        }
        if close {
            self.toast_until = None;
        }
        // 倒计时条要持续刷新，否则窗口静止时会停住
        ctx.request_repaint_after(Duration::from_millis(100));
    }

    /// 全部选中的文件下完后弹的询问框：要不要打开文件夹看看
    fn draw_done(&mut self, ctx: &egui::Context) {
        let Some(info) = self.done_info.clone() else {
            return;
        };
        // Esc / 回车都能操作，键盘用户不用摸鼠标
        let (esc, enter) = ctx.input(|i| {
            (
                i.key_pressed(egui::Key::Escape),
                i.key_pressed(egui::Key::Enter),
            )
        });
        if esc {
            self.done_info = None;
            return;
        }
        if enter {
            open_path(&info.outdir);
            self.done_info = None;
            return;
        }

        // 先把整块窗口压暗，底下的按钮在这期间点不到；点空白处等于「稍后」
        let screen = ctx.screen_rect();
        let mut veil_clicked = false;
        egui::Area::new(egui::Id::new("done-veil"))
            .order(egui::Order::Foreground)
            .fixed_pos(screen.min)
            .show(ctx, |ui| {
                let (rect, resp) = ui.allocate_exact_size(screen.size(), egui::Sense::click());
                ui.painter().rect_filled(
                    rect,
                    egui::Rounding::same(0.0),
                    egui::Color32::from_rgba_unmultiplied(26, 30, 48, 110),
                );
                veil_clicked = resp.clicked();
            });

        let mut open = false;
        let mut close = false;
        egui::Area::new(egui::Id::new("done-card"))
            .order(egui::Order::Tooltip)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, -10.0))
            .show(ctx, |ui| {
                pixel_card(ui, egui::vec2(24.0, 20.0), |ui| {
                    ui.set_width(440.0);

                    ui.horizontal(|ui| {
                        // 像素风的对勾方块，不用系统图标
                        let (r, _) = ui.allocate_exact_size(
                            egui::vec2(42.0, 42.0),
                            egui::Sense::hover(),
                        );
                        let p = ui.painter();
                        p.rect_filled(r, egui::Rounding::same(0.0), MINT);
                        p.rect_stroke(r, egui::Rounding::same(0.0), egui::Stroke::new(3.0, INK));
                        let c = r.center();
                        p.line_segment(
                            [c + egui::vec2(-10.0, 1.0), c + egui::vec2(-3.0, 8.0)],
                            egui::Stroke::new(4.0, INK),
                        );
                        p.line_segment(
                            [c + egui::vec2(-3.0, 8.0), c + egui::vec2(11.0, -8.0)],
                            egui::Stroke::new(4.0, INK),
                        );
                        ui.add_space(8.0);
                        ui.vertical(|ui| {
                            ui.add_space(1.0);
                            let title = if info.failed == 0 {
                                "全部下载完成"
                            } else {
                                "下载完成（有文件失败）"
                            };
                            ui.label(egui::RichText::new(title).font(px(20.0)).color(INK));
                            ui.add_space(2.0);
                            let sub = if info.failed == 0 {
                                format!("{} 个文件都已下好，断点记录已自动清理。", info.ok)
                            } else {
                                format!(
                                    "成功 {} 个 · 失败 {} 个，失败文件的断点已保留，可再试一次。",
                                    info.ok, info.failed
                                )
                            };
                            ui.label(egui::RichText::new(sub).font(pr(13.0)).color(TEXT2));
                        });
                    });

                    ui.add_space(14.0);
                    // 保存位置，用等宽字体截断显示
                    egui::Frame::none()
                        .fill(SOFT)
                        .stroke(egui::Stroke::new(2.0, INK))
                        .rounding(egui::Rounding::same(0.0))
                        .inner_margin(egui::Margin::symmetric(12.0, 9.0))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal(|ui| {
                                ui.label(
                                    egui::RichText::new("保存位置").font(px(12.5)).color(TEXT2),
                                );
                                ui.add_space(6.0);
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(&info.outdir)
                                            .font(egui::FontId::new(
                                                13.0,
                                                egui::FontFamily::Monospace,
                                            ))
                                            .color(INK),
                                    )
                                    .truncate(),
                                );
                            });
                        });

                    ui.add_space(12.0);
                    ui.label(
                        egui::RichText::new("现在打开这个文件夹看看吗？")
                            .font(pr(14.0))
                            .color(INK),
                    );
                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        if pixel_button(ui, "打开文件夹", 152.0, 44.0, BtnKind::Primary, true)
                            .clicked()
                        {
                            open = true;
                        }
                        ui.add_space(4.0);
                        if pixel_button(ui, "稍后，我自己去", 0.0, 44.0, BtnKind::Ghost, true)
                            .clicked()
                        {
                            close = true;
                        }
                    });
                });
            });

        if open {
            open_path(&info.outdir);
            self.done_info = None;
        }
        if close || veil_clicked {
            self.done_info = None;
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let mut start_after_probe = false;

        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Scan(rows, errors) => {
                    self.scanning = false;
                    self.rows = rows;
                    self.errors = errors;
                    let w = self.rows.iter().filter(|r| r.folder == "Windows").count();
                    let m = self.rows.iter().filter(|r| r.folder == "macOS").count();
                    self.status = if self.rows.is_empty() {
                        "没有扫描到可下载的资源".into()
                    } else {
                        format!(
                            "共 {} 个文件：Windows {} · macOS {} · 其他 {}",
                            self.rows.len(),
                            w,
                            m,
                            self.rows.len() - w - m
                        )
                    };
                    if self.demo {
                        for r in self.rows.iter_mut() {
                            r.selected = r.size <= 5_000_000;
                        }
                    }
                    // 扫完对一下磁盘，把「可续传」标出来
                    self.refresh_resume();
                    if !self.rows.is_empty() && self.routes.is_empty() {
                        self.start_probe(ctx);
                    }
                }
                Msg::Routes(routes) => {
                    self.probing = false;
                    let best = routes
                        .iter()
                        .filter(|r| r.ok)
                        .max_by(|a, b| {
                            a.speed
                                .partial_cmp(&b.speed)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .cloned();
                    self.routes = routes;
                    self.status = match best {
                        Some(b) => format!("测速完成，最快线路：{}（{}）", b.name, fmt_speed(b.speed)),
                        None => "线路测速失败，将按默认顺序逐个尝试".into(),
                    };
                    if self.pending_download {
                        self.pending_download = false;
                        start_after_probe = true;
                    }
                }
            }
        }

        if start_after_probe {
            self.start_download();
        }

        let downloading = self.prog.is_some() && !self.job_done.load(Ordering::SeqCst);
        if !self.job_reported && self.prog.is_some() && self.job_done.load(Ordering::SeqCst) {
            self.job_reported = true;
            let (done, total, _) = self.overall();
            let failed = self
                .progress_snapshot()
                .map(|v| v.iter().filter(|p| p.status == "失败").count())
                .unwrap_or(0);
            let secs = self.job_started.map(|t| t.elapsed().as_secs()).unwrap_or(0);
            let stopped = self.cancel.load(Ordering::SeqCst);
            let ok = done.saturating_sub(failed);
            self.status = if stopped {
                format!(
                    "已停止：完成 {}/{}，断点已保留，再点「开始下载」可接着下，用时 {}s",
                    ok, total, secs
                )
            } else if failed > 0 {
                format!(
                    "完成 {}/{}，{} 个失败（断点已保留，可再试一次），用时 {}s",
                    ok, total, failed, secs
                )
            } else {
                format!("全部完成 {}/{}，用时 {}s", done, total, secs)
            };
            // 列表里的「可续传 X%」跟着刷新；顺带重扫一遍未完成任务
            self.refresh_resume();
            self.pending = scan_pending(&self.outdir);
            self.show_pending = !self.pending.is_empty() && !stopped && failed > 0;
            // 下完（且不是被用户停掉的）才问「要不要打开文件夹」
            if !stopped && total > 0 && ok > 0 {
                self.done_info = Some(DoneInfo {
                    ok,
                    failed,
                    outdir: self.outdir.clone(),
                });
            }
        }

        // 用户换了保存目录 → 重新找一遍断点（输入过程中目录还不存在就先不扫）
        if self.outdir != self.outdir_seen && PathBuf::from(&self.outdir).is_dir() {
            self.outdir_seen = self.outdir.clone();
            self.pending = scan_pending(&self.outdir);
            if !downloading {
                self.show_pending = !self.pending.is_empty();
            }
            self.refresh_resume();
        }

        if downloading || self.scanning || self.probing {
            ctx.request_repaint_after(Duration::from_millis(200));
        }

        if self.demo_start {
            self.demo_start = false;
            self.start_scan(ctx);
        }

        let mut do_scan = false;
        let mut do_probe = false;
        let mut do_download = false;
        let mut do_cancel = false;
        let mut do_open = false;
        let mut do_resume = false;
        let mut do_drop_pending = false;
        // 本帧鼠标停在哪条说明上（每帧重新判定，移开就自然消失）
        let mut hover_tip: Option<Tip> = None;

        // ---------------- 顶部标题栏
        egui::TopBottomPanel::top("head")
            .exact_height(78.0)
            .frame(
                egui::Frame::none()
                    .fill(PAPER)
                    .inner_margin(egui::Margin::symmetric(20.0, 0.0)),
            )
            .show(ctx, |ui| {
                let full = ui.max_rect();
                ui.painter().rect_filled(
                    egui::Rect::from_min_size(
                        egui::pos2(full.left(), full.bottom() - 3.0),
                        egui::vec2(full.width(), 3.0),
                    ),
                    egui::Rounding::same(0.0),
                    INK,
                );
                ui.allocate_ui_with_layout(
                    egui::vec2(ui.available_width(), 74.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        if let Some(tex) = &self.icon_tex {
                            egui::Frame::none()
                                .fill(CREAM)
                                .stroke(egui::Stroke::new(2.5, INK))
                                .rounding(egui::Rounding::same(0.0))
                                .inner_margin(egui::Margin::same(3.0))
                                .show(ui, |ui| {
                                    // 48 = 16(像素画边长) × 3，最近邻放大后每块像素一样大，不会变形
                                    ui.add(egui::Image::new(egui::load::SizedTexture::new(
                                        tex.id(),
                                        egui::vec2(48.0, 48.0),
                                    )));
                                });
                            ui.add_space(14.0);
                        }
                        ui.vertical(|ui| {
                            ui.add_space(4.0);
                            ui.label(
                                egui::RichText::new("GitHub Release 下载整理工具")
                                    .font(px(21.0))
                                    .color(INK),
                            );
                            ui.add_space(1.0);
                            ui.label(
                                egui::RichText::new("扫描 · 分类 · 测速择优 · 多线程下载")
                                    .font(pr(13.5))
                                    .color(TEXT2),
                            );
                        });

                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                ui.label(
                                    egui::RichText::new(format!("v{}", APP_VERSION))
                                        .font(pr(13.0))
                                        .color(TEXT2),
                                );
                                ui.add_space(10.0);
                                let best = self.best_route();
                                let (txt, fg, bg) = match &best {
                                    Some(b) => (
                                        format!("线路 {} · {}", b.name, fmt_speed(b.speed)),
                                        egui::Color32::from_rgb(8, 116, 88),
                                        egui::Color32::from_rgb(206, 245, 232),
                                    ),
                                    None if self.probing => (
                                        "正在测速…".to_string(),
                                        egui::Color32::from_rgb(150, 92, 6),
                                        egui::Color32::from_rgb(255, 236, 190),
                                    ),
                                    None => ("尚未测速".to_string(), TEXT2, SOFT),
                                };
                                if chip(ui, &txt, fg, bg).clicked() {
                                    self.show_routes = !self.show_routes;
                                }
                            },
                        );
                    },
                );
            });

        // ---------------- 底部操作栏
        egui::TopBottomPanel::bottom("foot")
            .exact_height(82.0)
            .frame(
                egui::Frame::none()
                    .fill(PAPER)
                    .inner_margin(egui::Margin::symmetric(20.0, 0.0)),
            )
            .show(ctx, |ui| {
                let full = ui.max_rect();
                ui.painter().rect_filled(
                    egui::Rect::from_min_size(
                        egui::pos2(full.left(), full.top()),
                        egui::vec2(full.width(), 3.0),
                    ),
                    egui::Rounding::same(0.0),
                    INK,
                );
                ui.allocate_ui_with_layout(
                    egui::vec2(ui.available_width(), 78.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        let (done, total, frac) = self.overall();
                        let spd: f64 = self
                            .progress_snapshot()
                            .map(|s| s.iter().map(|p| p.speed).sum())
                            .unwrap_or(0.0);
                        let live = downloading && spd >= 1024.0;
                        let recv_all = self.received_all();

                        // 进度条 + 紧跟其下的总速度，一眼能看到整体在不在跑
                        ui.allocate_ui_with_layout(
                            egui::vec2(232.0, 78.0),
                            egui::Layout::top_down(egui::Align::Center),
                            |ui| {
                                let txt = if live {
                                    format!("总速度 {}", fmt_speed(spd))
                                } else if downloading {
                                    "总速度 0 B/s · 正在换线路".to_string()
                                } else if total > 0 {
                                    format!("已下 {}", fmt_size(recv_all))
                                } else {
                                    String::new()
                                };
                                // 没有小字时把进度条往下压一点，视觉上居中，不留一条空带
                                ui.add_space(if txt.is_empty() { 25.0 } else { 16.0 });
                                bar(ui, frac, 232.0, 18.0);
                                if !txt.is_empty() {
                                    ui.add_space(3.0);
                                    ui.label(
                                        egui::RichText::new(txt)
                                            .font(pr(12.5))
                                            .color(if live { TEXT2 } else { CORAL }),
                                    );
                                }
                            },
                        );
                        ui.add_space(14.0);

                        let info_w = (ui.available_width() - 246.0).max(120.0);
                        ui.allocate_ui_with_layout(
                            egui::vec2(info_w, 78.0),
                            egui::Layout::top_down(egui::Align::LEFT),
                            |ui| {
                                ui.add_space(14.0);
                                let head = if total > 0 {
                                    format!("{}/{}   {:.0}%", done, total, frac * 100.0)
                                } else {
                                    "等待任务".to_string()
                                };
                                ui.label(egui::RichText::new(head).font(px(16.0)).color(INK));
                                ui.add_space(2.0);
                                // 卡顿时把「在重连、大概多久、不用管」直接写在状态行，
                                // 用户瞟一眼就知道不是卡死
                                let stalled = downloading && !live;
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(if stalled {
                                            NOTE_SHORT
                                        } else {
                                            self.status.as_str()
                                        })
                                        .font(pr(13.0))
                                        .color(if stalled { CORAL } else { TEXT2 }),
                                    )
                                    .truncate(),
                                );
                            },
                        );

                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if downloading {
                                    if pixel_button(ui, "停止", 0.0, 48.0, BtnKind::Danger, true)
                                        .clicked()
                                    {
                                        do_cancel = true;
                                    }
                                    ui.add_space(14.0);
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "已用 {}s",
                                            self.job_started
                                                .map(|t| t.elapsed().as_secs())
                                                .unwrap_or(0)
                                        ))
                                        .font(pr(13.5))
                                        .color(TEXT2),
                                    );
                                } else {
                                    let ready = !self.rows.is_empty();
                                    let label = if self.probing {
                                        "测速完成后开始"
                                    } else {
                                        "开始下载"
                                    };
                                    if pixel_button(
                                        ui,
                                        label,
                                        176.0,
                                        48.0,
                                        BtnKind::Primary,
                                        ready,
                                    )
                                    .clicked()
                                    {
                                        if self.probing {
                                            self.pending_download = true;
                                        } else {
                                            do_download = true;
                                        }
                                    }
                                }
                            },
                        );
                    },
                );
            });

        // ---------------- 线路详情（可折叠）
        if self.show_routes {
            egui::TopBottomPanel::bottom("routes")
                .frame(
                    egui::Frame::none()
                        .fill(SOFT)
                        .inner_margin(egui::Margin::symmetric(20.0, 12.0)),
                )
                .show(ctx, |ui| {
                    let full = ui.max_rect();
                    ui.painter().rect_filled(
                        egui::Rect::from_min_size(
                            egui::pos2(full.left(), full.top()),
                            egui::vec2(full.width(), 3.0),
                        ),
                        egui::Rounding::same(0.0),
                        INK,
                    );
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("加速线路实测速度")
                                .font(px(15.0))
                                .color(INK),
                        );
                        ui.add_space(6.0);
                        ui.label(
                            egui::RichText::new("下载时按此顺序优先使用，失败自动切换")
                                .font(pr(13.0))
                                .color(TEXT2),
                        );
                    });
                    ui.add_space(8.0);
                    ui.horizontal_wrapped(|ui| {
                        for r in &self.routes {
                            let (fg, bg) = if r.ok {
                                (
                                    egui::Color32::from_rgb(8, 116, 88),
                                    egui::Color32::from_rgb(206, 245, 232),
                                )
                            } else {
                                (TEXT2, egui::Color32::from_rgb(246, 232, 210))
                            };
                            let val = if r.ok {
                                fmt_speed(r.speed)
                            } else {
                                "不可用".to_string()
                            };
                            pill(ui, &format!("{}  {}", r.name, val), fg, bg);
                            ui.add_space(8.0);
                        }
                        if self.routes.is_empty() {
                            ui.label(
                                egui::RichText::new("扫描完成后会自动测速")
                                    .font(pr(13.0))
                                    .color(TEXT2),
                            );
                        }
                    });
                });
        }

        // ---------------- 主区域
        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(BG)
                    .inner_margin(egui::Margin::symmetric(20.0, 16.0)),
            )
            .show(ctx, |ui| {
                // 米色底 + 极淡像素点阵，像素风底纹
                let bg_rect = ui.max_rect();
                let dot = egui::Color32::from_rgb(246, 230, 203);
                let mut y = bg_rect.top();
                while y < bg_rect.bottom() {
                    let mut x = bg_rect.left();
                    while x < bg_rect.right() {
                        ui.painter().rect_filled(
                            egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(2.0, 2.0)),
                            egui::Rounding::same(0.0),
                            dot,
                        );
                        x += 22.0;
                    }
                    y += 22.0;
                }

                let content_w = ui.available_width();

                // ===== 仓库输入
                pixel_card(ui, egui::vec2(18.0, 16.0), |ui| {
                    ui.set_max_width(content_w - 46.0);
                    section_title(
                        ui,
                        "仓库地址",
                        "每行一个，支持 owner/repo、GitHub 链接、git@ 形式",
                    );
                    ui.add_space(10.0);

                    input_box(ui, |ui| {
                        ui.add(
                            egui::TextEdit::multiline(&mut self.repos)
                                .frame(false)
                                .desired_rows(3)
                                .desired_width(ui.available_width())
                                .font(egui::FontId::new(14.0, egui::FontFamily::Monospace))
                                .hint_text("microsoft/PowerToys\nsharkdp/bat"),
                        );
                    });

                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        let filters_before = (self.latest_only, self.include_pre);
                        check_row_tip(
                            ui,
                            &mut self.latest_only,
                            "只取最新版本",
                            TIP_LATEST.0,
                            TIP_LATEST.1,
                            &mut hover_tip,
                        );
                        ui.add_space(4.0);
                        check_row_tip(
                            ui,
                            &mut self.include_pre,
                            "包含 Pre-release",
                            TIP_PRE.0,
                            TIP_PRE.1,
                            &mut hover_tip,
                        );
                        // 切换筛选条件后自动重扫，省得再点一次按钮
                        if (self.latest_only, self.include_pre) != filters_before
                            && !self.rows.is_empty()
                            && !self.scanning
                        {
                            do_scan = true;
                        }
                        ui.add_space(10.0);
                        let token_label = field_label_tip(ui, "Token");
                        input_box(ui, |ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.token)
                                    .frame(false)
                                    .desired_width(170.0)
                                    .hint_text("可选，私有仓库 / 限流时填"),
                            );
                        });
                        if token_label.hovered() {
                            hover_tip = Some(Tip {
                                title: TIP_TOKEN.0,
                                body: TIP_TOKEN.1,
                                anchor: token_label.rect,
                            });
                        }

                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                let label = if self.scanning {
                                    "扫描中…"
                                } else {
                                    "扫描 Release"
                                };
                                if pixel_button(
                                    ui,
                                    label,
                                    156.0,
                                    44.0,
                                    BtnKind::Primary,
                                    !self.scanning,
                                )
                                .clicked()
                                {
                                    do_scan = true;
                                }
                            },
                        );
                    });

                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        field_label(ui, "保存到");
                        let box_w = (ui.available_width() - 214.0).max(180.0);
                        input_box(ui, |ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.outdir)
                                    .frame(false)
                                    .desired_width(box_w - 22.0),
                            );
                        });
                        if pixel_button(ui, "浏览…", 92.0, 36.0, BtnKind::Ghost, true).clicked() {
                            if let Some(dir) = pick_folder() {
                                self.outdir = dir;
                            }
                        }
                        if pixel_button(ui, "打开目录", 108.0, 36.0, BtnKind::Ghost, true).clicked()
                        {
                            do_open = true;
                        }
                    });
                });

                if !self.errors.is_empty() {
                    ui.add_space(12.0);
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(255, 238, 194))
                        .stroke(egui::Stroke::new(2.5, INK))
                        .rounding(egui::Rounding::same(0.0))
                        .inner_margin(egui::Margin::symmetric(14.0, 10.0))
                        .show(ui, |ui| {
                            for e in &self.errors {
                                ui.label(
                                    egui::RichText::new(e)
                                        .font(pr(13.5))
                                        .color(egui::Color32::from_rgb(138, 82, 6)),
                                );
                            }
                        });
                }

                ui.add_space(14.0);

                // ===== 断点续传提示条
                if self.show_pending && !self.pending.is_empty() && !downloading {
                    let have: u64 = self.pending.iter().map(|(_, h)| *h).sum();
                    let size: u64 = self.pending.iter().map(|(m, _)| m.size).sum();
                    let pct = if size > 0 {
                        (have as f64 / size as f64 * 100.0).min(100.0)
                    } else {
                        0.0
                    };
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(255, 236, 190))
                        .stroke(egui::Stroke::new(3.0, INK))
                        .rounding(egui::Rounding::same(0.0))
                        .inner_margin(egui::Margin::symmetric(16.0, 12.0))
                        .outer_margin(egui::Margin {
                            right: SH + 3.0,
                            bottom: SH + 3.0,
                            left: 0.0,
                            top: 0.0,
                        })
                        .show(ui, |ui| {
                            ui.set_min_width(content_w - 52.0);
                            ui.horizontal(|ui| {
                                // 左侧：小方块 + 文案
                                let (mark, _) = ui.allocate_exact_size(
                                    egui::vec2(12.0, 12.0),
                                    egui::Sense::hover(),
                                );
                                ui.painter().rect_filled(
                                    mark,
                                    egui::Rounding::same(0.0),
                                    egui::Color32::from_rgb(198, 48, 32),
                                );
                                ui.add_space(3.0);
                                ui.vertical(|ui| {
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "有 {} 个文件上次没下完 · 已下 {} / {}（{:.0}%）",
                                            self.pending.len(),
                                            fmt_size(have),
                                            fmt_size(size),
                                            pct
                                        ))
                                        .font(px(15.0))
                                        .color(INK),
                                    );
                                    ui.add_space(1.0);
                                    ui.label(
                                        egui::RichText::new(
                                            "点「继续下载」从断点接着下，已经下好的部分不会重下。",
                                        )
                                        .font(pr(12.5))
                                        .color(egui::Color32::from_rgb(120, 78, 8)),
                                    );
                                });

                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if pixel_button(
                                            ui,
                                            "删除断点",
                                            0.0,
                                            38.0,
                                            BtnKind::Ghost,
                                            true,
                                        )
                                        .clicked()
                                        {
                                            do_drop_pending = true;
                                        }
                                        ui.add_space(2.0);
                                        if pixel_button(
                                            ui,
                                            "继续下载",
                                            118.0,
                                            38.0,
                                            BtnKind::Primary,
                                            true,
                                        )
                                        .clicked()
                                        {
                                            do_resume = true;
                                        }
                                    },
                                );
                            });
                        });
                }

                ui.add_space(14.0);

                // ===== 文件列表
                let list_h = (ui.available_height() - 6.0).max(200.0);
                pixel_card(ui, egui::vec2(18.0, 14.0), |ui| {
                    ui.set_max_width(content_w - 46.0);
                    ui.set_min_height(list_h - 32.0);
                    ui.horizontal(|ui| {
                        let (mark, _) = ui.allocate_exact_size(
                            egui::vec2(11.0, 11.0),
                            egui::Sense::hover(),
                        );
                        ui.painter().rect_filled(mark, egui::Rounding::same(0.0), CORAL);
                        ui.add_space(2.0);
                        ui.label(egui::RichText::new("文件列表").font(px(17.0)).color(INK));
                        ui.add_space(8.0);
                        ui.label(
                            egui::RichText::new(format!(
                                "共 {} 个 · 已选 {}",
                                self.rows.len(),
                                self.selected_count()
                            ))
                            .font(pr(13.5))
                            .color(TEXT2),
                        );
                        let probing = self.probing;
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if pixel_button(
                                    ui,
                                    if probing { "测速中…" } else { "重新测速" },
                                    108.0,
                                    34.0,
                                    BtnKind::Ghost,
                                    !self.rows.is_empty() && !probing,
                                )
                                .clicked()
                                {
                                    do_probe = true;
                                }
                                if pixel_button(ui, "仅 macOS", 0.0, 34.0, BtnKind::Ghost, true)
                                    .clicked()
                                {
                                    for r in self.rows.iter_mut() {
                                        r.selected = r.folder == "macOS";
                                    }
                                }
                                if pixel_button(ui, "仅 Windows", 0.0, 34.0, BtnKind::Ghost, true)
                                    .clicked()
                                {
                                    for r in self.rows.iter_mut() {
                                        r.selected = r.folder == "Windows";
                                    }
                                }
                                if pixel_button(ui, "全不选", 0.0, 34.0, BtnKind::Ghost, true)
                                    .clicked()
                                {
                                    for r in self.rows.iter_mut() {
                                        r.selected = false;
                                    }
                                }
                                if pixel_button(ui, "全选", 0.0, 34.0, BtnKind::Ghost, true)
                                    .clicked()
                                {
                                    for r in self.rows.iter_mut() {
                                        r.selected = true;
                                    }
                                }
                            },
                        );
                    });

                    ui.add_space(12.0);

                        if self.rows.is_empty() {
                            let h = (list_h - 110.0).max(120.0);
                            ui.allocate_ui(egui::vec2(ui.available_width(), h), |ui| {
                                ui.vertical_centered(|ui| {
                                    ui.add_space(h * 0.30);
                                    ui.label(
                                        egui::RichText::new("还没有扫描结果")
                                            .font(px(19.0))
                                            .color(TEXT2),
                                    );
                                    ui.add_space(6.0);
                                    ui.label(
                                        egui::RichText::new(
                                            "在上面填入仓库地址（如 microsoft/PowerToys），点「扫描 Release」",
                                        )
                                        .font(pr(13.5))
                                        .color(TEXT2),
                                    );
                                });
                            });
                            return;
                        }

                        let snapshot = self.progress_snapshot();
                        let mut rows = std::mem::take(&mut self.rows);
                        let table_h = (list_h - 96.0).max(120.0);

                        use egui_extras::{Column, TableBuilder};
                        let to_top = self.scroll_top;
                        self.scroll_top = false;
                        let mut table = TableBuilder::new(ui)
                            .striped(true)
                            .scroll_bar_visibility(
                                egui::scroll_area::ScrollBarVisibility::AlwaysVisible,
                            )
                            .resizable(false)
                            .auto_shrink([false, false])
                            .min_scrolled_height(table_h)
                            .max_scroll_height(table_h)
                            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                            .column(Column::exact(34.0))
                            .column(Column::remainder().at_least(240.0))
                            .column(Column::exact(106.0))
                            .column(Column::exact(94.0))
                            .column(Column::exact(286.0));
                        if to_top {
                            table = table.scroll_to_row(0, Some(egui::Align::TOP));
                        }
                        table
                            .header(34.0, |mut h| {
                                h.col(|_ui| {});
                                h.col(|ui| {
                                    ui.label(
                                        egui::RichText::new("文件名").font(px(13.5)).color(TEXT2),
                                    );
                                });
                                h.col(|ui| {
                                    ui.label(
                                        egui::RichText::new("平台").font(px(13.5)).color(TEXT2),
                                    );
                                });
                                h.col(|ui| {
                                    ui.label(
                                        egui::RichText::new("大小").font(px(13.5)).color(TEXT2),
                                    );
                                });
                                h.col(|ui| {
                                    ui.label(
                                        egui::RichText::new("状态 / 进度")
                                            .font(px(13.5))
                                            .color(TEXT2),
                                    );
                                });
                            })
                            .body(|mut body| {
                                for (i, row) in rows.iter_mut().enumerate() {
                                    body.row(44.0, |mut r| {
                                        r.col(|ui| {
                                            check_row(ui, &mut row.selected, "");
                                        });
                                        r.col(|ui| {
                                            ui.add(
                                                egui::Label::new(
                                                    egui::RichText::new(&row.asset)
                                                        .font(egui::FontId::new(
                                                            14.5,
                                                            egui::FontFamily::Monospace,
                                                        ))
                                                        .color(INK),
                                                )
                                                .truncate(),
                                            )
                                            .on_hover_text(format!(
                                                "保存为：{}\n来源：{}",
                                                row.target, row.url
                                            ));
                                        });
                                        r.col(|ui| {
                                            platform_badge(ui, &row.folder);
                                        });
                                        r.col(|ui| {
                                            ui.label(
                                                egui::RichText::new(fmt_size(row.size))
                                                    .font(egui::FontId::new(
                                                        13.5,
                                                        egui::FontFamily::Monospace,
                                                    ))
                                                    .color(TEXT2),
                                            );
                                        });
                                        r.col(|ui| {
                                            let state = snapshot
                                                .as_ref()
                                                .and_then(|s| s.get(i).map(|p| p.clone()));
                                            match state {
                                                Some(p) => match p.status.as_str() {
                                                    "下载中" => {
                                                        let frac = if p.total > 0 {
                                                            p.received as f32 / p.total as f32
                                                        } else {
                                                            0.0
                                                        };
                                                        bar(ui, frac, 96.0, 14.0);
                                                        ui.add_space(2.0);
                                                        ui.label(
                                                            egui::RichText::new(format!(
                                                                "{:.0}%",
                                                                frac * 100.0
                                                            ))
                                                            .font(px(13.5))
                                                            .color(INK),
                                                        );
                                                        // 速度掉到几乎为 0，说明这条连接被限速或挂了，
                                                        // 程序正在换线路重连，直接把状态说清楚，别让人以为死机
                                                        let slow = !p.note.is_empty() || p.speed < 1024.0;
                                                        let lb = ui.label(
                                                            egui::RichText::new(if slow {
                                                                "换线路中…".to_string()
                                                            } else {
                                                                fmt_speed(p.speed)
                                                            })
                                                            .font(pr(12.5))
                                                            .color(if slow { CORAL } else { TEXT2 }),
                                                        );
                                                        if slow {
                                                            lb.on_hover_text(NOTE_RECONNECT);
                                                        }
                                                    }
                                                    // 分片下完了正在拼成一个文件，几秒钟，说明白点免得以为卡住
                                                    "合并中" => pill(
                                                        ui,
                                                        "合并中…",
                                                        egui::Color32::from_rgb(122, 76, 12),
                                                        SUN,
                                                    ),
                                                    "完成" => pill(
                                                        ui,
                                                        "已完成",
                                                        egui::Color32::from_rgb(8, 116, 88),
                                                        egui::Color32::from_rgb(
                                                            206, 245, 232,
                                                        ),
                                                    ),
                                                    "失败" => {
                                                        ui.add(
                                                            egui::Label::new(
                                                                egui::RichText::new("失败")
                                                                    .font(px(13.5))
                                                                    .color(ERR_RED),
                                                            )
                                                            .truncate(),
                                                        )
                                                        .on_hover_text(if p.error.is_empty() {
                                                            "下载失败".to_string()
                                                        } else {
                                                            p.error.clone()
                                                        });
                                                        ui.add(
                                                            egui::Label::new(
                                                                egui::RichText::new(&p.error)
                                                                    .font(pr(12.5))
                                                                    .color(ERR_RED),
                                                            )
                                                            .truncate(),
                                                        );
                                                    }
                                                    other => {
                                                        ui.label(
                                                            egui::RichText::new(other)
                                                                .font(pr(13.5))
                                                                .color(TEXT2),
                                                        );
                                                    }
                                                },
                                                None => {
                                                    if row.resume > 0 {
                                                        let pct = if row.size > 0 {
                                                            row.resume as f32 / row.size as f32
                                                        } else {
                                                            0.0
                                                        };
                                                        pill(
                                                            ui,
                                                            &format!("可续传 {:.0}%", pct * 100.0),
                                                            egui::Color32::from_rgb(120, 78, 8),
                                                            egui::Color32::from_rgb(255, 236, 190),
                                                        );
                                                        ui.label(
                                                            egui::RichText::new(format!(
                                                                "已下 {}",
                                                                fmt_size(row.resume)
                                                            ))
                                                            .font(pr(12.5))
                                                            .color(TEXT2),
                                                        );
                                                    } else {
                                                        ui.label(
                                                            egui::RichText::new("待下载")
                                                                .font(pr(13.5))
                                                                .color(TEXT2),
                                                        );
                                                    }
                                                }
                                            }
                                        });
                                    });
                                }
                            });

                        self.rows = rows;
                    });
            });

        if do_scan {
            self.start_scan(ctx);
        }
        if do_probe {
            self.start_probe(ctx);
        }
        if do_download {
            self.start_download();
        }
        if do_cancel {
            self.cancel.store(true, Ordering::SeqCst);
            self.status = "正在停止…".into();
        }
        if do_open {
            open_path(&self.outdir);
        }
        if do_resume {
            self.start_resume();
        }
        if do_drop_pending {
            self.drop_pending();
        }

        // 浮在最上层，最后画，避免被卡片/表格盖住
        self.draw_promo(ctx);
        // 下载完成后的询问框盖在一切之上
        self.draw_done(ctx);

        // 截图自查用：RO_TIP=pre|token|latest 直接把对应说明钉在固定位置
        if let Some(which) = self.tip_force.clone() {
            let (title, body) = match which.as_str() {
                "latest" => TIP_LATEST,
                "token" => TIP_TOKEN,
                _ => TIP_PRE,
            };
            let tip = Tip {
                title,
                body,
                anchor: egui::Rect::from_min_size(egui::pos2(60.0, 240.0), egui::vec2(240.0, 30.0)),
            };
            let pos = self.tip_position(ctx, tip);
            show_tip(ctx, tip, pos);
        } else if let Some(tip) = hover_tip {
            // 在同一处停够 0.32 秒才弹，鼠标只是划过不会闪出卡片
            let now = Instant::now();
            let started = match self.tip_wait {
                Some((k, t)) if k == tip.title => t,
                _ => {
                    self.tip_wait = Some((tip.title, now));
                    self.tip_pos = None;
                    now
                }
            };
            let delay = Duration::from_millis(320);
            let waited = now.saturating_duration_since(started);
            if waited >= delay {
                // 位置在弹出那一刻定下来，之后鼠标微动卡片不会跟着抖
                let pos = match self.tip_pos {
                    Some(p) => p,
                    None => {
                        let p = self.tip_position(ctx, tip);
                        self.tip_pos = Some(p);
                        p
                    }
                };
                show_tip(ctx, tip, pos);
            } else {
                ctx.request_repaint_after(delay - waited);
            }
        } else {
            self.tip_wait = None;
            self.tip_pos = None;
        }
    }
}


/// 隐藏的下载自测入口：--dl <url> <size> <outdir> [name]
fn bench_download(args: &[String]) {
    let url = args.get(2).cloned().unwrap_or_default();
    let size: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let outdir = args
        .get(4)
        .cloned()
        .unwrap_or_else(|| "_dl_out".to_string());
    let name = args
        .get(5)
        .cloned()
        .unwrap_or_else(|| "file.bin".to_string());
    let _ = std::fs::create_dir_all(&outdir);
    let row = Row {
        repo: "test/x".into(),
        tag: "v1".into(),
        asset: name.clone(),
        folder: "Windows".into(),
        arch: "x64".into(),
        size,
        url,
        target: name,
        selected: true,
        resume: 0,
    };
    let prog = Arc::new(Mutex::new(Vec::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let t0 = Instant::now();
    spawn_download(
        vec![row],
        outdir,
        vec![("直连".to_string(), String::new())],
        prog.clone(),
        cancel,
        done.clone(),
    );
    while !done.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(300) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let el = t0.elapsed().as_secs_f64();
    let snapshot = prog.lock().map(|v| v.clone()).unwrap_or_default();
    for p in snapshot.iter() {
        println!(
            "status={} recv={}/{} err={} elapsed={:.2}s avg={}",
            p.status,
            p.received,
            p.total,
            p.error,
            el,
            fmt_speed(p.received as f64 / el.max(0.05))
        );
    }
}

fn main() -> eframe::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        selftest();
        return Ok(());
    }
    if args.iter().any(|a| a == "--dl") {
        bench_download(&args);
        return Ok(());
    }
    if args.iter().any(|a| a == "--pick") {
        match pick_folder() {
            Some(p) => println!("选中目录: {}", p),
            None => println!("未选择（取消或调用失败）"),
        }
        return Ok(());
    }
    if args.iter().any(|a| a == "--fontcheck") {
        font_check();
        return Ok(());
    }
    // 隐藏自测入口：列出某个目录里可续传的任务
    if args.iter().any(|a| a == "--pending") {
        let dir = args.get(2).cloned().unwrap_or_default();
        let list = scan_pending(&dir);
        println!("pending={}", list.len());
        for (m, h) in list {
            let pct = if m.size > 0 {
                h as f64 / m.size as f64 * 100.0
            } else {
                0.0
            };
            println!(
                "  {}  {}/{} ({:.0}%)  {}",
                m.target,
                fmt_size(h),
                fmt_size(m.size),
                pct,
                m.url
            );
        }
        return Ok(());
    }
    let icon = egui::IconData {
        rgba: include_bytes!("../assets/icon.rgba").to_vec(),
        width: 256,
        height: 256,
    };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1150.0, 800.0])
            .with_min_inner_size([960.0, 660.0])
            .with_icon(icon)
            .with_title(APP_NAME),
        ..Default::default()
    };
    eframe::run_native(
        APP_NAME,
        options,
        Box::new(|cc| Ok(Box::new(App::new(cc)))),
    )
}
