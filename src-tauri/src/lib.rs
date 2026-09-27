use std::{
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// The sharing server prints this line once every listener is bound; it is the
/// readiness contract between server.js and this shell.
const READY_LINE: &str = "u-wash is ready";

/// Machine-readable marker the sharing server puts on startup-failure output;
/// the wording after it is human-readable and may change.
const STARTUP_ERROR_PREFIX: &str = "UWASH_STARTUP_ERROR:";

#[derive(Default)]
struct SidecarStatus {
    ready: bool,
    exited: Option<Option<i32>>,
    stderr: Vec<String>,
}

fn kill_sidecar<R: tauri::Runtime>(manager: &impl tauri::Manager<R>) {
    if let Some(child) = manager.state::<Mutex<Option<CommandChild>>>().lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Picks the human reason shown in the startup-failure dialog: a
/// UWASH_STARTUP_ERROR line from the sharing server wins, then the last
/// stderr output, then the exit code itself.
fn failure_reason(stderr: &[String], code: Option<i32>) -> String {
    stderr
        .iter()
        .rev()
        .find_map(|line| line.trim().strip_prefix(STARTUP_ERROR_PREFIX).map(|reason| reason.trim().to_string()))
        .or_else(|| {
            stderr
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_else(|| match code {
            Some(code) => format!("the sharing server exited with code {code}"),
            None => "the sharing server exited before it was ready".to_string(),
        })
}

fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let desktop_addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8766);
    if TcpStream::connect_timeout(&desktop_addr.into(), Duration::from_millis(200)).is_ok() {
        return Err("u-wash Desktop is already running (port 8766 is in use). Close the other u-wash window and try again.".into());
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
    let cable_setup = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("vbcable").join("VBCABLE_Setup_x64.exe")
    } else {
        app.path().resource_dir()?.join("resources").join("vbcable").join("VBCABLE_Setup_x64.exe")
    };
    let command = app
        .shell()
        .sidecar("uwash-server")?
        .env("UWASH_DATA_DIR", data_dir)
        .env("UWASH_ASSETS_DIR", assets_dir)
        .env("UWASH_CABLE_SETUP", cable_setup)
        .env("UWASH_DESKTOP_PORT", "8766")
        .env("UWASH_PARENT_PID", std::process::id().to_string());
    let (mut events, child) = command.spawn()?;
    app.manage(Mutex::new(Some(child)));

    let event_status = Arc::new(Mutex::new(SidecarStatus::default()));
    {
        let status = event_status.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                        let text = String::from_utf8_lossy(&line).to_string();
                        println!("{}", text);
                        if text.trim() == READY_LINE {
                            status.lock().unwrap().ready = true;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                        let text = String::from_utf8_lossy(&line).to_string();
                        eprintln!("{}", text);
                        let mut state = status.lock().unwrap();
                        state.stderr.push(text);
                        if state.stderr.len() > 8 {
                            state.stderr.remove(0);
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                        status.lock().unwrap().exited = Some(payload.code);
                        break;
                    }
                    tauri_plugin_shell::process::CommandEvent::Error(text) => {
                        let mut state = status.lock().unwrap();
                        state.stderr.push(text);
                        state.exited = Some(None);
                        break;
                    }
                    _ => {}
                }
            }
            // A closed event stream without a Terminated event still counts as an exit.
            let mut state = status.lock().unwrap();
            if state.exited.is_none() {
                state.exited = Some(None);
            }
        });
    }

    // Wait for the readiness line, failing immediately if the sidecar exits first.
    let started = Instant::now();
    let mut failure: Option<String> = None;
    loop {
        {
            let state = event_status.lock().unwrap();
            if state.ready {
                break;
            }
            if let Some(code) = state.exited {
                let reason = failure_reason(&state.stderr, code);
                failure = Some(format!("u-wash Desktop could not start.\n\n{reason}"));
                break;
            }
        }
        if started.elapsed() >= Duration::from_secs(10) {
            failure = Some(
                "u-wash Desktop could not start: the sharing server did not become ready within 10 seconds.\n\nIf a u-wash server is running from \"npm start\" or another window, close it and try again."
                    .into(),
            );
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    if let Some(message) = failure {
        kill_sidecar(app);
        return Err(message.into());
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External("http://127.0.0.1:8766/".parse()?))
        .title("u-wash Desktop")
        .inner_size(1000.0, 760.0)
        .min_inner_size(720.0, 560.0)
        .build()?;
    Ok(())
}

pub fn run() {
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| match start(app) {
            Ok(()) => Ok(()),
            Err(error) => {
                app.handle()
                    .dialog()
                    .message(error.to_string())
                    .title("u-wash Desktop")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                Err(error)
            }
        })
        .build(tauri::generate_context!());
    match built {
        Ok(app) => app.run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_sidecar(app);
            }
        }),
        Err(error) => {
            eprintln!("u-wash Desktop failed to start: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_error_line_wins_over_other_output() {
        let stderr = vec![
            "noise before".to_string(),
            format!("{STARTUP_ERROR_PREFIX} the sharing port 8765 is already in use."),
        ];
        assert_eq!(failure_reason(&stderr, Some(1)), "the sharing port 8765 is already in use.");
    }

    #[test]
    fn last_stderr_line_is_the_fallback() {
        let stderr = vec![String::new(), "Error: ENOTDIR".to_string()];
        assert_eq!(failure_reason(&stderr, Some(1)), "Error: ENOTDIR");
    }

    #[test]
    fn exit_code_is_the_last_resort() {
        assert_eq!(failure_reason(&[], Some(3)), "the sharing server exited with code 3");
        assert_eq!(failure_reason(&[], None), "the sharing server exited before it was ready");
    }
}
