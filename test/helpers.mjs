import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';

// Minimal HTTP and WebSocket clients shared by the test suites. The HTTP
// client keeps its own cookie jar so pairing flows read naturally.
export function createClient({ host, port, tls, origin }) {
  const transport = tls ? https : http;
  const agent = tls ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  const state = { cookie: null };
  const request = (method, route, body, type, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: host, port, path: route, method, agent,
      headers: { Origin: origin, ...(state.cookie ? { Cookie: state.cookie } : {}), ...(body ? { 'Content-Type': type || 'application/json', 'Content-Length': body.length } : {}), ...extraHeaders },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const setCookie = res.headers['set-cookie']?.[0];
        if (setCookie) state.cookie = setCookie.split(';')[0];
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  request.cookie = () => state.cookie;
  return request;
}

export function openSocket({ host, port, tls, origin, cookie }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${tls ? 'wss' : 'ws'}://${host}:${port}/ws`, { rejectUnauthorized: false, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
