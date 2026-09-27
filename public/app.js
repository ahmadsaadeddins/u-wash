const $ = id => document.getElementById(id);
let socket;
let micStream, micContext, micNode;
let playingContext, outputStream, outputElement, playAt = 0, streamRate = 48000;
let latestClipboard = '';
let meterTimer;
let reconnectEnabled = true;
let phoneUrl = '';
let desktopMode = false;

function status(message, bad = false) { $('connection').textContent = message; $('connection').classList.toggle('off', bad); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin' });
  if (!response.ok) { let body = {}; try { body = await response.json(); } catch {} throw new Error(body.error || `Request failed (${response.status})`); }
  return response.headers.get('content-type')?.includes('json') ? response.json() : response;
}
async function init() {
  try {
    const { paired, desktop } = await api('/api/session');
    desktopMode = desktop;
    $('pairView').hidden = paired; $('appView').hidden = !paired;
    $('logoutButton').hidden = !paired || desktop;
    $('desktopPanel').hidden = !desktop;
    $('openDownloads').hidden = !desktop;
    $('installCable').hidden = !desktop;
    $('downloadHint').hidden = !desktop;
    if (desktop) {
      const info = await api('/api/desktop');
      phoneUrl = info.phoneUrls.join('\n');
      $('phoneUrl').textContent = info.phoneUrls.join('  or  ') || 'No local network address found';
      $('desktopPin').textContent = info.pin;
    }
    if (paired) { status('Connected'); connectSocket(); await Promise.all([refreshFiles(), refreshClipboard()]); }
    else status('Pairing needed', true);
  } catch { status('Server unavailable', true); }
}
$('pairForm').addEventListener('submit', async event => {
  event.preventDefault(); $('pairMessage').textContent = '';
  try { await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pin').value }) }); await init(); }
  catch (error) { $('pairMessage').textContent = error.message; }
});
function connectSocket() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => status('Connected');
  socket.onclose = async () => {
    if (micStream) stopMic();
    if (!reconnectEnabled) return;
    status('Reconnecting', true);
    try {
      const { paired } = await api('/api/session');
      if (!paired) { reconnectEnabled = false; $('pairView').hidden = false; $('appView').hidden = true; $('logoutButton').hidden = true; status('Pairing needed', true); return; }
    } catch { /* The server may be restarting. */ }
    setTimeout(connectSocket, 2000);
  };
  socket.onmessage = async event => {
    if (typeof event.data !== 'string') { playSamples(event.data); return; }
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') { if (msg.clipboard) displayClipboard(msg.clipboard); if (msg.microphoneActive) { streamRate = msg.microphoneRate; $('micStatus').textContent = 'Microphone is streaming on another device'; setMeter(true); } }
    if (msg.type === 'mic-start') { streamRate = msg.sampleRate; playAt = 0; $('micStatus').textContent = 'Microphone is streaming'; setMeter(true); }
    if (msg.type === 'mic-stop') { playAt = 0; $('micStatus').textContent = 'Microphone is off'; setMeter(false); }
    if (msg.type === 'clipboard') displayClipboard(msg);
    if (msg.type === 'files-changed') refreshFiles();
  };
}
$('logoutButton').onclick = async () => {
  reconnectEnabled = false;
  try { await api('/api/logout', { method: 'POST' }); socket?.close(); location.reload(); }
  catch (error) { reconnectEnabled = true; status(error.message, true); }
};
$('copyPhoneUrl').onclick = async () => {
  if (!phoneUrl) return;
  try { await navigator.clipboard.writeText(phoneUrl); $('copyPhoneUrl').textContent = 'Copied'; }
  catch { $('copyPhoneUrl').textContent = 'Select the link to copy'; }
};
$('openDownloads').onclick = async () => {
  try { await api('/api/open-downloads', { method: 'POST' }); }
  catch (error) { $('downloadHint').textContent = `Could not open Downloads: ${error.message}`; }
};
$('installCable').onclick = async () => {
  try { await api('/api/install-cable', { method: 'POST' }); $('routeStatus').textContent = 'VB-CABLE setup launched. Approve the admin prompt, finish its installer, then restart Windows.'; }
  catch (error) { $('routeStatus').textContent = `Could not start the VB-CABLE setup: ${error.message}`; }
};
function displayClipboard(data) {
  latestClipboard = data.text || '';
  $('clipboardText').value = latestClipboard;
  $('clipboardStatus').textContent = data.updatedAt ? `Last shared ${new Date(data.updatedAt).toLocaleString()}` : 'No text shared yet';
}
async function refreshClipboard() { displayClipboard(await api('/api/clipboard')); }
$('sendText').onclick = async () => {
  try { displayClipboard(await api('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('clipboardText').value }) })); }
  catch (error) { $('clipboardStatus').textContent = error.message; }
};
$('pasteText').onclick = async () => {
  try { $('clipboardText').value = await navigator.clipboard.readText(); $('clipboardStatus').textContent = 'Pasted. Select Send text to share it.'; }
  catch { $('clipboardStatus').textContent = 'Browser blocked clipboard reading. Paste into the box manually.'; }
};
$('copyText').onclick = async () => {
  try { await navigator.clipboard.writeText(latestClipboard); $('clipboardStatus').textContent = 'Copied to this device’s clipboard'; }
  catch { $('clipboardStatus').textContent = 'Browser blocked clipboard writing. Select and copy the text manually.'; }
};
function setMeter(active) {
  clearInterval(meterTimer); $('meter').classList.toggle('active', active);
  for (const bar of $('meter').children) bar.style.height = '9px';
  if (active) meterTimer = setInterval(() => { for (const bar of $('meter').children) bar.style.height = `${9 + Math.random() * 48}px`; }, 120);
}
async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs a secure HTTPS page. Accept the local certificate warning and reload.');
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Connection is not ready');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false }, video: false });
  micContext = new AudioContext();
  await micContext.audioWorklet.addModule('/audio-worklet.js');
  const source = micContext.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micContext, 'mic-capture');
  micNode.port.onmessage = event => { if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 512000) socket.send(event.data.buffer); };
  source.connect(micNode);
  micNode.connect(micContext.destination);
  socket.send(JSON.stringify({ type: 'mic-start', sampleRate: micContext.sampleRate }));
  $('micButton').textContent = 'Stop microphone'; $('micStatus').textContent = 'Microphone is streaming'; setMeter(true);
  micStream.getAudioTracks()[0].onended = stopMic;
}
async function stopMic() {
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null; micNode?.disconnect(); micNode = null;
  if (micContext) await micContext.close(); micContext = null;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'mic-stop' }));
  $('micButton').textContent = 'Start microphone'; $('micStatus').textContent = 'Microphone is off'; setMeter(false);
}
$('micButton').onclick = async () => {
  if (micStream) return stopMic();
  try { await startMic(); } catch (error) { await stopMic(); $('micStatus').textContent = error.message; }
};
function preparePlayback() {
  if (playingContext) return;
  playingContext = new AudioContext();
  outputStream = playingContext.createMediaStreamDestination();
  outputElement = document.createElement('audio');
  outputElement.autoplay = true;
  outputElement.srcObject = outputStream.stream;
  document.body.append(outputElement);
}
$('listenButton').onclick = async () => {
  try {
    preparePlayback();
    if (outputElement.setSinkId) await outputElement.setSinkId('default');
    await playingContext.resume(); await outputElement.play();
    $('listenButton').textContent = 'Sound enabled'; $('routeStatus').textContent = 'Playing through the computer’s default speakers.';
  } catch (error) { $('routeStatus').textContent = `Could not start sound: ${error.message}`; }
};
$('routeButton').onclick = async () => {
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !HTMLMediaElement.prototype.setSinkId) throw new Error('Open this page in desktop Chrome or Edge over HTTPS.');
    preparePlayback();
    let device;
    if (navigator.mediaDevices.selectAudioOutput) {
      device = await navigator.mediaDevices.selectAudioOutput();
      if (!/CABLE Input|VB-Audio Virtual Cable/i.test(device.label)) throw new Error('Choose Speakers or CABLE Input (VB-Audio Virtual Cable) in the output picker.');
    } else {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      device = devices.find(item => item.kind === 'audiooutput' && /CABLE Input|VB-Audio Virtual Cable/i.test(item.label));
      if (!device) throw new Error('VB-Audio Virtual Cable playback was not found. Install VB-CABLE, restart Windows, then reload this page.');
    }
    await outputElement.setSinkId(device.deviceId);
    await playingContext.resume(); await outputElement.play();
    $('routeButton').textContent = 'Virtual mic active';
    $('routeStatus').textContent = 'Audio is going to VB-CABLE. In Codex, choose CABLE Output as the microphone.';
  } catch (error) { $('routeStatus').textContent = error.message; }
};
function playSamples(arrayBuffer) {
  if (!playingContext || playingContext.state !== 'running') return;
  const floats = new Float32Array(arrayBuffer);
  const buffer = playingContext.createBuffer(1, floats.length, streamRate);
  buffer.copyToChannel(floats, 0);
  const source = playingContext.createBufferSource(); source.buffer = buffer; source.connect(outputStream);
  const now = playingContext.currentTime;
  if (playAt < now || playAt > now + .4) playAt = now + .08;
  source.start(playAt); playAt += buffer.duration;
}
function niceSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
async function refreshFiles() {
  try {
    const { files } = await api('/api/files'); const list = $('fileList'); list.replaceChildren();
    $('fileStatus').textContent = '';
    if (!files.length) { const div = document.createElement('div'); div.className = 'empty'; div.textContent = 'No files yet. Add one to get started.'; list.append(div); return; }
    for (const file of files) {
      const row = document.createElement('div'); row.className = 'fileRow';
      const info = document.createElement('div');
      const name = document.createElement('div'); name.className = 'fileName'; name.textContent = file.path;
      const meta = document.createElement('div'); meta.className = 'fileMeta'; meta.textContent = `${niceSize(file.size)} · ${new Date(file.updatedAt).toLocaleString()}`;
      info.append(name, meta);
      const link = document.createElement('a'); link.href = `/api/download?path=${encodeURIComponent(file.path)}`; link.textContent = 'Download';
      link.addEventListener('click', () => { if (desktopMode) $('downloadHint').textContent = 'Download started. Use Open Downloads folder to find it.'; });
      row.append(info, link); list.append(row);
    }
  } catch (error) { $('fileStatus').textContent = `Could not list shared files: ${error.message}`; }
}
async function uploadFiles(input) {
  const files = Array.from(input.files || []);
  for (let i = 0; i < files.length; i++) {
    const file = files[i], name = file.webkitRelativePath || file.name;
    $('uploadStatus').textContent = `Uploading ${i + 1} of ${files.length}: ${name}`;
    try { await api(`/api/upload?path=${encodeURIComponent(name)}`, { method: 'PUT', body: file }); }
    catch (error) { $('uploadStatus').textContent = `Could not upload ${name}: ${error.message}`; input.value = ''; return; }
  }
  $('uploadStatus').textContent = `${files.length} file${files.length === 1 ? '' : 's'} uploaded`;
  input.value = ''; await refreshFiles();
}
$('fileInput').onchange = event => uploadFiles(event.target);
$('folderInput').onchange = event => uploadFiles(event.target);
window.addEventListener('beforeunload', () => { if (micStream && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'mic-stop' })); });
init();
