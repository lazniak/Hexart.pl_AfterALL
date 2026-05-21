// =====================================================================
// HEXART.PL/AfterALL - MCP HTTP Bridge (in-AE side)
// =====================================================================
// Runs a localhost-only HTTP server inside the CEP Node.js context.
// Exposes plugin features over POST endpoints.
// Authenticated via Bearer token shared with the MCP server.
//
// The bridge is OFF by default. Enable in Settings -> MCP Bridge.
// =====================================================================

(function (global) {
    'use strict';

    const http = require('http');
    const crypto = require('crypto');

    class McpBridge {
        constructor(opts) {
            opts = opts || {};
            this.host = opts.host || '127.0.0.1'; // never bind 0.0.0.0
            this.port = opts.port || 7890;
            this.token = opts.token || '';
            this.handlers = {};       // path -> async (body, ctx) => result
            this.logBuffer = [];      // tail of recent activity for /get_logs
            this.maxLog = 500;
            this.server = null;
            this.tasks = {};          // task_id -> { status, result, error, startedAt }
            this._taskCounter = 0;
        }

        // ----- Lifecycle ------------------------------------------------
        start() {
            if (this.server) return { running: true, port: this.port };
            return new Promise((resolve, reject) => {
                this.server = http.createServer((req, res) => this._handle(req, res));
                this.server.on('error', (e) => {
                    this._log('error', 'Bridge listen error: ' + e.message);
                    if (this._startReject) { this._startReject(e); this._startReject = null; }
                });
                this._startReject = reject;
                this.server.listen(this.port, this.host, () => {
                    this._startReject = null;
                    this._log('success', 'Bridge listening on ' + this.host + ':' + this.port);
                    resolve({ running: true, port: this.port, host: this.host });
                });
            });
        }
        stop() {
            return new Promise((resolve) => {
                if (!this.server) { resolve({ running: false }); return; }
                this.server.close(() => {
                    this.server = null;
                    this._log('info', 'Bridge stopped.');
                    resolve({ running: false });
                });
            });
        }
        isRunning() { return !!this.server; }

        // ----- Configuration --------------------------------------------
        setToken(t) { this.token = t || ''; }
        setPort(p) { this.port = parseInt(p, 10) || 7890; }
        generateToken() {
            this.token = crypto.randomBytes(24).toString('base64url');
            return this.token;
        }

        // ----- Handler registry -----------------------------------------
        on(path, handler) {
            if (!path.startsWith('/')) path = '/' + path;
            this.handlers[path] = handler;
        }

        // ----- Logging --------------------------------------------------
        _log(level, msg) {
            const entry = { ts: Date.now(), level, msg };
            this.logBuffer.push(entry);
            if (this.logBuffer.length > this.maxLog) this.logBuffer.shift();
            // Mirror to the UI log console if available (set up via setUiLogger)
            if (this._uiLogger) {
                try { this._uiLogger('[MCP] ' + msg, level); } catch(_) {}
            }
        }
        setUiLogger(fn) { this._uiLogger = fn; }
        getLogs(limit) {
            const n = Math.min(this.maxLog, Math.max(1, limit || 100));
            return this.logBuffer.slice(-n);
        }

        // ----- Task tracking (for async send_prompt) --------------------
        createTask() {
            const id = 't_' + Date.now() + '_' + (++this._taskCounter);
            this.tasks[id] = { id, status: 'running', startedAt: Date.now(), result: null, error: null, progress: 0, message: '' };
            return id;
        }
        updateTask(id, patch) { if (this.tasks[id]) Object.assign(this.tasks[id], patch); }
        getTask(id) { return this.tasks[id] || null; }
        // Garbage-collect tasks older than 1 hour
        gcTasks() {
            const cutoff = Date.now() - 60 * 60 * 1000;
            Object.keys(this.tasks).forEach(id => {
                if (this.tasks[id].startedAt < cutoff && this.tasks[id].status !== 'running') {
                    delete this.tasks[id];
                }
            });
        }

        // ----- HTTP plumbing --------------------------------------------
        async _handle(req, res) {
            const sendJSON = (status, body) => {
                const payload = JSON.stringify(body);
                res.writeHead(status, {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                });
                res.end(payload);
            };

            // CORS preflight
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                });
                return res.end();
            }
            if (req.method !== 'POST') {
                return sendJSON(405, { error: 'Only POST is supported.' });
            }

            // Auth
            if (this.token) {
                const auth = req.headers['authorization'] || '';
                const presented = auth.startsWith('Bearer ') ? auth.substring(7) : '';
                if (presented !== this.token) {
                    this._log('warning', 'Auth failed for ' + req.url + ' (from ' + req.socket.remoteAddress + ')');
                    return sendJSON(401, { error: 'Invalid token. Configure AFTERALL_TOKEN to match the plugin Settings -> MCP Bridge -> Token.' });
                }
            }

            // Read body
            let raw = '';
            req.setEncoding('utf8');
            req.on('data', chunk => {
                raw += chunk;
                if (raw.length > 25 * 1024 * 1024) {
                    req.destroy();
                }
            });
            req.on('end', async () => {
                let body = {};
                if (raw.length > 0) {
                    try { body = JSON.parse(raw); }
                    catch (e) { return sendJSON(400, { error: 'Invalid JSON: ' + e.message }); }
                }
                const handler = this.handlers[req.url];
                if (!handler) {
                    return sendJSON(404, { error: 'Unknown endpoint: ' + req.url });
                }
                try {
                    this._log('info', 'POST ' + req.url);
                    const ctx = { remoteAddr: req.socket.remoteAddress };
                    const result = await handler(body, ctx);
                    sendJSON(200, result == null ? { ok: true } : result);
                } catch (err) {
                    this._log('error', 'Handler ' + req.url + ' threw: ' + err.message);
                    sendJSON(500, { error: err && err.message ? err.message : String(err) });
                }
            });
            req.on('error', (e) => {
                this._log('warning', 'Request error: ' + e.message);
            });
        }
    }

    global.AfterAllMcpBridge = McpBridge;
})(typeof window !== 'undefined' ? window : globalThis);
