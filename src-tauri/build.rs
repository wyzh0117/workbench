fn main() {
    // The frontend is embedded into the binary at compile time, so a change
    // under `app/` must retrigger this build script.  Without these lines a
    // plain `cargo build` silently ships the previous interface.
    println!("cargo:rerun-if-changed=../app");
    println!("cargo:rerun-if-changed=../app/index.html");
    println!("cargo:rerun-if-changed=../app/boot.js");
    println!("cargo:rerun-if-changed=../app/main.js");
    println!("cargo:rerun-if-changed=../app/views.js");
    println!("cargo:rerun-if-changed=../app/authoring.js");
    println!("cargo:rerun-if-changed=../app/canvas.js");
    println!("cargo:rerun-if-changed=../app/constants.js");
    println!("cargo:rerun-if-changed=../app/recovery.js");
    println!("cargo:rerun-if-changed=../app/styles.css");
    tauri_build::build()
}
