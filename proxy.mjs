import https from 'https';
import httpProxy from 'http-proxy';
import fs from 'node:fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const PORT = process.env.PORT || 5228;
const TARGET = process.env.PROXY_TARGET || 'http://localhost:11434';
const API_KEY_HASHES = JSON.parse(process.env.API_KEY_HASHES);
const SSL_KEY_PATH = process.env.SSL_KEY_PATH.startsWith('~')
  ? path.join(os.homedir(), process.env.SSL_KEY_PATH.slice(1))
  : process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH.startsWith('~')
  ? path.join(os.homedir(), process.env.SSL_CERT_PATH.slice(1))
  : process.env.SSL_CERT_PATH;

if (!API_KEY_HASHES) {
  console.error("API_KEY_HASHES not set in environment. And there's fallback to allow all.");
  process.exit(1);
}

function sha256Hash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isValidApiKey(providedKey) {
  const keyHash = sha256Hash(providedKey);
  return API_KEY_HASHES.includes(keyHash);
}

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH),
};

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
});


const server = https.createServer(options, (req, res) => {
  const apiKey = req.headers['x-api-key'];
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  
  if (!isValidApiKey(apiKey)) {
    console.warn(`Unauthorized access attempt from ${req.socket.remoteAddress}, path: ${req.url}`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing API key' }));
    return;
  }

  proxy.web(req, res, (err) => {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway' }));
  });
});

server.on('connection', (socket) => {
  console.log(`${new Date().toISOString()} - [TCP CONNECTION] Connection from ${socket.remoteAddress}:${socket.remotePort}`);
});

server.listen(PORT, () => {
  console.log(`HTTPS proxy server listening on port ${PORT}, forwarding to ${TARGET}`);
});
