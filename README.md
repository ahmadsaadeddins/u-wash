# u-wash

Use your phone as a live microphone for your computer, and share files, folders, and clipboard text between devices on your local network.

## Windows desktop app (Tauri)

The desktop window starts the sharing server automatically. The phone still connects through its browser over local HTTPS; no phone app is required.

To build and run from this repository, install Node.js 24, Rust with the MSVC toolchain, and the Windows build tools required by [Tauri](https://v2.tauri.app/start/prerequisites/). Then run:

```powershell
cd F:\Github\u-wash
npm install
npm run desktop:dev
```

To make a Windows installer, run `npm run desktop:build`. The NSIS installer is written under `src-tauri/target/release/bundle/nsis/`. Release builds keep shared files and the local HTTPS certificate in `%APPDATA%\com.uwash.desktop`; development builds use this repository's `shared/` and `.local/` folders.

The desktop window displays the phone URLs and current pairing code. Open one of those addresses on a phone on the same Wi-Fi and enter the code. Accept the local certificate warning on the phone. Allow **u-wash** through Windows Firewall on Private networks if prompted. Keep the desktop app open while using the phone. To send the phone microphone into Codex, follow the VB-CABLE steps below.

In the desktop window, **Download** saves a copy to your Windows Downloads folder. If WebView2 asks whether to allow the download, choose **Allow**. Click **Open Downloads folder** to find the saved file. The original shared file remains in u-wash's app data folder.

The desktop app uses ports 8765 (phone HTTPS) and 8766 (desktop loopback). Close a separately started `npm start` server before opening the desktop app. Only one desktop instance can run at a time. If a port is already taken, or the server stops during startup, the desktop window does not open: an error dialog names the port or reason. A server started with `npm start` prints the same error in its terminal.

## Start without Tauri

Requires Node.js 20 or newer.

On Windows, you can double-click `start.bat`. Or run:

```powershell
cd F:\Github\u-wash
npm install
npm start
```

1. Open the **Computer** URL printed by the server and enter the pairing code.
2. On a phone connected to the same Wi-Fi, open the **Phone** URL and enter the same code.
3. Your browser will warn about the local self-signed certificate. Choose the option to continue to the site. If the phone cannot reach the site, allow Node.js through Windows Firewall on **Private networks**.
4. On the computer, click **Enable sound here**. On the phone, click **Start microphone** and grant microphone permission.

The computer plays the phone's microphone through its speakers or headphones. Headphones avoid feedback.

### Use as a microphone in Codex or another Windows app

In the installed desktop app, click **Install VB-CABLE** to launch the bundled driver installer (approve the Windows admin prompt, finish VB-CABLE's own installer, then restart Windows), or download [VB-CABLE](https://vb-audio.com/Cable/) from its publisher yourself. On the computer's u-wash page, click **Route to virtual mic** and choose **Speakers (VB-Audio Virtual Cable)** or **CABLE Input (VB-Audio Virtual Cable)**, whichever your Windows version lists. In Codex or another app, choose **CABLE Output (VB-Audio Virtual Cable)** as the microphone. If Codex does not offer a device picker, select CABLE Output under **Windows Settings → System → Sound → Input** before starting voice chat. This routes only u-wash's audio to the cable; other browser tabs stay on their normal output. Chrome or Edge on Windows is recommended for the audio-output picker.

Choose **Add files** or **Add folder** on either device. Files are available to download from either device. The Node version saves them in `shared/`; the installed desktop app saves them under `%APPDATA%\com.uwash.desktop\shared`. Folder picking depends on browser support; selecting multiple files always works. Individual files have a 1 GB limit. Files with the same path are overwritten.

For text, paste or type into the box and click **Send text**. On the other device, click **Copy to this device**. Browser permission rules prevent automatic reading or writing of the system clipboard in the background.

### Limits

- Pairing: 5 wrong codes pause pairing from that device for 60 seconds. Up to 32 devices can be paired at once; restarting the server clears all sessions, and sessions otherwise expire after 24 hours.
- Files: 1 GB per file, up to 2 uploads at a time, and listings show up to 5,000 files. Uploads without a declared length are refused with the same size-limit message.
- Text: 50,000 characters per clipboard message.
- Microphone: up to 8 connected devices, counting the desktop window, can listen at once; a sender exceeding roughly 2 MB/s is disconnected.

## Notes

- Everything stays on the local network. The generated HTTPS key and certificate are stored in `.local/`; neither `.local/` nor `shared/` is tracked by Git.
- By default the server listens on local network interfaces so the phone can connect. Set `UWASH_HOST=127.0.0.1` to allow connections from the computer only.
- The pairing code changes on each start unless `UWASH_PIN` is set. Restarting the server clears all paired sessions.
- Paired devices can select **Unpair** to revoke their own session. Sessions also expire after 24 hours. A new pairing code is shown when the server restarts.
- The certificate includes the computer's current local IP addresses. If the computer's IP changes, delete `.local/key.pem` and `.local/cert.pem` while the server is stopped, then restart.
- The desktop window plays the microphone through its selected audio output. It does not install a system-wide virtual microphone driver; use VB-CABLE for other apps to capture it.
- The Windows installer bundles the unmodified VB-CABLE driver pack, a donationware from [vb-cable.com](http://www.vb-cable.com) redistributed as-is under its license; the **Install VB-CABLE** button simply launches its own setup program, and all donations go to its author.
- Run `npm test` for the smoke and startup tests (the startup suite also boots the packaged sidecar when `src-tauri/binaries` has been built). The symlink-confinement assertions need permission to create symlinks (Windows Developer Mode or an administrator shell); without it the suite prints a warning and skips them. Set `UWASH_TEST_REQUIRE_SYMLINKS=1` to fail instead of skip.
