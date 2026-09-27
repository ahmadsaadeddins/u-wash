# u-wash

Use your phone as a live microphone for your computer, and share files, folders, and clipboard text between devices on your local network.

## Start

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

Install [VB-CABLE](https://vb-audio.com/Cable/) from its publisher and restart Windows. On the computer's u-wash page, click **Route to virtual mic** and choose **Speakers (VB-Audio Virtual Cable)** or **CABLE Input (VB-Audio Virtual Cable)**, whichever your Windows version lists. In Codex or another app, choose **CABLE Output (VB-Audio Virtual Cable)** as the microphone. If Codex does not offer a device picker, select CABLE Output under **Windows Settings → System → Sound → Input** before starting voice chat. This routes only u-wash's audio to the cable; other browser tabs stay on their normal output. Chrome or Edge on Windows is recommended for the audio-output picker.

Choose **Add files** or **Add folder** on either device. Files are saved in `shared/` and are available to download from either device. Folder picking depends on browser support; selecting multiple files always works. Individual files have a 1 GB limit. Files with the same path are overwritten.

For text, paste or type into the box and click **Send text**. On the other device, click **Copy to this device**. Browser permission rules prevent automatic reading or writing of the system clipboard in the background.

## Notes

- Everything stays on the local network. The generated HTTPS key and certificate are stored in `.local/`; neither `.local/` nor `shared/` is tracked by Git.
- By default the server listens on local network interfaces so the phone can connect. Set `UWASH_HOST=127.0.0.1` to allow connections from the computer only.
- The pairing code changes on each start unless `UWASH_PIN` is set. Restarting the server clears all paired sessions.
- Paired devices can select **Unpair** to revoke their own session. Sessions also expire after 24 hours. A new pairing code is shown when the server restarts.
- The certificate includes the computer's current local IP addresses. If the computer's IP changes, delete `.local/key.pem` and `.local/cert.pem` while the server is stopped, then restart.
- This browser-based version plays the microphone in the computer's browser. It does not install a system-wide virtual microphone driver.
