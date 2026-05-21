// =====================================================================
// HEXART.PL/AfterALL MCP — HTTP bridge client
// =====================================================================
// Talks to the plugin's local HTTP bridge running inside After Effects.
// =====================================================================

import http from 'node:http';

const DEFAULT_HOST = process.env.AFTERALL_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.AFTERALL_PORT || '7890', 10);
const DEFAULT_TOKEN = process.env.AFTERALL_TOKEN || '';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AFTERALL_TIMEOUT_MS || '300000', 10);

export class BridgeClient {
    constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, token = DEFAULT_TOKEN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.host = host;
        this.port = port;
        this.token = token;
        this.timeoutMs = timeoutMs;
    }

    async call(path, body = {}, opts = {}) {
        const timeoutMs = opts.timeoutMs || this.timeoutMs;
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body || {});
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            };
            if (this.token) headers['Authorization'] = 'Bearer ' + this.token;

            const req = http.request({
                host: this.host,
                port: this.port,
                path: path,
                method: 'POST',
                headers,
                timeout: timeoutMs
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(JSON.parse(data || '{}')); }
                        catch (e) { resolve({ raw: data }); }
                    } else {
                        let parsed = null;
                        try { parsed = JSON.parse(data); } catch (_) {}
                        const msg = (parsed && parsed.error) || data || ('HTTP ' + res.statusCode);
                        const err = new Error('Bridge ' + res.statusCode + ': ' + msg);
                        err.status = res.statusCode;
                        err.body = parsed || data;
                        reject(err);
                    }
                });
            });
            req.on('error', (e) => {
                if (e.code === 'ECONNREFUSED') {
                    reject(new Error(
                        'AfterALL bridge not reachable at ' + this.host + ':' + this.port + '. ' +
                        'Make sure After Effects is running with the HEXART.PL/AfterALL panel open ' +
                        '(Window → Extensions → HEXART.PL/AfterALL) and the MCP bridge is enabled in plugin settings.'
                    ));
                } else {
                    reject(new Error('Bridge transport error: ' + e.message));
                }
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Bridge request timed out after ' + timeoutMs + 'ms.'));
            });
            req.write(payload);
            req.end();
        });
    }
}
