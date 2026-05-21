// Quick connectivity test for the AfterALL HTTP bridge.
// Usage: node src/test-bridge.js [--token=...] [--port=7890]
import { BridgeClient } from './bridge.js';

const argv = process.argv.slice(2);
const argMap = {};
for (const a of argv) {
    if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split('=');
        argMap[k] = v ?? true;
    }
}

const bridge = new BridgeClient({
    host: argMap.host,
    port: argMap.port ? parseInt(argMap.port, 10) : undefined,
    token: argMap.token,
    timeoutMs: 5000
});

(async () => {
    console.log('Testing bridge at ' + bridge.host + ':' + bridge.port + '...');
    try {
        const status = await bridge.call('/status', {});
        console.log('✓ Bridge OK');
        console.log(JSON.stringify(status, null, 2));
    } catch (e) {
        console.error('✕ ' + e.message);
        process.exit(1);
    }
})();
