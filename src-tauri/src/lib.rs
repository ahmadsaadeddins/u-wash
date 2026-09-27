use std::{
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let desktop_addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8766);
            if TcpStream::connect_timeout(&desktop_addr.into(), Duration::from_millis(200)).is_ok() {
                return Err("u-wash Desktop is already running on port 8766".into());
            }

            let data_dir = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .ok_or("missing project directory")?
                    .to_path_buf()
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            let assets_dir = app.path().resource_dir()?.join("resources").join("public");
            let command = app
                .shell()
                .sidecar("uwash-server")?
                .env("UWASH_DATA_DIR", data_dir)
                .env("UWASH_ASSETS_DIR", assets_dir)
                .env("UWASH_DESKTOP_PORT", "8766")
                .env("UWASH_PARENT_PID", std::process::id().to_string());
            let (mut events, child) = command.spawn()?;
            app.manage(Mutex::new(Some(child)));

            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                            println!("{}", String::from_utf8_lossy(&line));
                        }
                        tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                            eprintln!("{}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });

            let mut ready = false;
            for _ in 0..100 {
                if TcpStream::connect_timeout(&desktop_addr.into(), Duration::from_millis(100)).is_ok() {
                    ready = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if !ready {
                if let Some(child) = app.state::<Mutex<Option<CommandChild>>>().lock().unwrap().take() {
                    let _ = child.kill();
                }
                return Err("u-wash sharing server did not start".into());
            }

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("http://127.0.0.1:8766/".parse()?),
            )
            .title("u-wash Desktop")
            .inner_size(1000.0, 760.0)
            .min_inner_size(720.0, 560.0)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build u-wash Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app.state::<Mutex<Option<CommandChild>>>().lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
