// =====================================================================
// HEXART.PL/AfterALL — Core Agent (provider-agnostic)
// =====================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

// Backwards-compatible config path (legacy name kept so existing users don't lose data)
const aisistDataPath = path.join(os.homedir(), '.aisist_ae_data.json');
const hexartDataPath = path.join(os.homedir(), '.hexart_afterall_data.json');

let aisistDiskData = {};
try {
    // Prefer new file; fall back to legacy
    const sourcePath = fs.existsSync(hexartDataPath) ? hexartDataPath
        : (fs.existsSync(aisistDataPath) ? aisistDataPath : null);
    if (sourcePath) {
        aisistDiskData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    }
} catch(e) {
    console.error('Storage load error:', e);
    aisistDiskData = {};
}

// Atomic write helper — writes to .tmp, then renames to prevent corruption on crash.
function _atomicWrite(filePath, content) {
    const tmp = filePath + '.tmp';
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        try { fs.renameSync(tmp, filePath); }
        catch(renameErr) {
            // Windows rename can fail if file is locked — fall back to copy + unlink
            fs.copyFileSync(tmp, filePath);
            try { fs.unlinkSync(tmp); } catch(_) {}
        }
        return true;
    } catch(e) {
        console.error('Atomic write failed:', filePath, e);
        return false;
    }
}

const diskStorage = {
    getItem(key) {
        const v = aisistDiskData[key];
        return (v === undefined || v === null) ? null : v;
    },
    setItem(key, value) {
        aisistDiskData[key] = value;
        // Write to both paths to keep legacy users in sync during transition
        _atomicWrite(hexartDataPath, JSON.stringify(aisistDiskData));
    },
    removeItem(key) {
        delete aisistDiskData[key];
        _atomicWrite(hexartDataPath, JSON.stringify(aisistDiskData));
    },
    // Bulk get — used to detect storage corruption / surface stats
    getAll() { return Object.assign({}, aisistDiskData); }
};
window.diskStorage = diskStorage;

class AisistAgent {
    constructor() {
        // ---- Validated storage helpers ----------------------------------
        const getStr = (key, def) => {
            const v = diskStorage.getItem(key);
            return (typeof v === 'string' && v.length) ? v : (def || '');
        };
        const getJSON = (key, def) => {
            const raw = diskStorage.getItem(key);
            if (!raw) return def;
            try { return JSON.parse(raw); } catch (e) { return def; }
        };

        // ---- API keys ---------------------------------------------------
        this.apiKey = getStr('aisist_api_key');
        this.openrouterApiKey = getStr('hexart_openrouter_key');
        this.replicateApiKey = getStr('aisist_replicate_key');
        this.elevenlabsApiKey = getStr('aisist_elevenlabs_key');

        // ---- Heal bug where ElevenLabs key overwrote baseModel ---------
        let storedBaseModel = getStr('aisist_base_model');
        if (storedBaseModel && (storedBaseModel.startsWith('sk_') || storedBaseModel.startsWith('xi-'))) {
            if (!this.elevenlabsApiKey) {
                this.elevenlabsApiKey = storedBaseModel;
                diskStorage.setItem('aisist_elevenlabs_key', storedBaseModel);
            }
            storedBaseModel = '';
        }

        // ---- Providers configuration -----------------------------------
        // LLM provider: 'gemini' | 'openrouter' | 'lmstudio'
        this.llmProvider = getStr('hexart_llm_provider', 'gemini') || 'gemini';
        this.imgProvider = getStr('hexart_img_provider', 'gemini') || 'gemini';

        // Per-provider model selections
        this.geminiModel = storedBaseModel || getStr('hexart_gemini_model', 'gemini-2.5-flash');
        this.openrouterLLMModel = getStr('hexart_openrouter_llm_model', 'anthropic/claude-3.5-sonnet');
        this.lmstudioLLMModel = getStr('hexart_lmstudio_llm_model', '');
        this.lmstudioBaseUrl = getStr('hexart_lmstudio_url', 'http://localhost:1234');

        this.geminiImageModel = getStr('hexart_gemini_img_model', 'gemini-2.5-flash-image-preview');
        this.openrouterImageModel = getStr('hexart_openrouter_img_model', 'google/gemini-2.5-flash-image-preview');

        // Effective active model (computed from provider+model). Kept for backward compat.
        this.baseModel = this.geminiModel;
        this.imageModel = this.geminiImageModel;

        this.ttsModel = getStr('aisist_tts_model', 'gemini-2.5-flash-preview-tts');
        this.ttsVoice = getStr('aisist_tts_voice', 'Auto');
        this.uiLanguage = getStr('aisist_ui_lang', 'auto');
        this.projectLanguage = getStr('aisist_proj_lang', 'auto');

        // ---- TTS / STT provider routing (Gemini or ElevenLabs) ---------
        this.ttsProvider = getStr('hexart_tts_provider', 'gemini') || 'gemini';
        this.sttProvider = getStr('hexart_stt_provider', 'elevenlabs') || 'elevenlabs';

        // ElevenLabs configuration
        this.elevenlabsModel = getStr('hexart_elevenlabs_model', 'eleven_multilingual_v2');
        this.elevenlabsSttModel = getStr('hexart_elevenlabs_stt_model', 'scribe_v2');
        // Auto-migrate legacy scribe_v1 selection → scribe_v2 (silent upgrade)
        if (this.elevenlabsSttModel === 'scribe_v1' || this.elevenlabsSttModel === 'scribe_v1_experimental') {
            this.elevenlabsSttModel = 'scribe_v2';
            diskStorage.setItem('hexart_elevenlabs_stt_model', 'scribe_v2');
        }
        this.elevenlabsDefaultVoice = getStr('hexart_elevenlabs_default_voice');
        this.elevenlabsMaleVoice = getStr('hexart_elevenlabs_male_voice');
        this.elevenlabsFemaleVoice = getStr('hexart_elevenlabs_female_voice');
        this.elevenlabsUseGeneralDefault = diskStorage.getItem('hexart_elevenlabs_use_general_default') === 'true';
        this.elevenlabsOutputFormat = getStr('hexart_elevenlabs_output_format', 'mp3_44100_128');
        // SFX / Music defaults
        this.elevenlabsSfxPromptInfluence = parseFloat(getStr('hexart_elevenlabs_sfx_influence', '0.3'));
        this.elevenlabsSfxDefaultDuration = parseFloat(getStr('hexart_elevenlabs_sfx_default_duration', '0'));  // 0 = auto
        this.elevenlabsMusicForceInstrumental = diskStorage.getItem('hexart_elevenlabs_music_force_instr') !== 'false';
        // Music provider: 'gemini' (Lyria 3 Pro) | 'elevenlabs' (Eleven Music)
        this.musicProvider = getStr('hexart_music_provider', 'gemini');
        let elSettings = getJSON('hexart_elevenlabs_voice_settings', null);
        if (!elSettings || typeof elSettings !== 'object') {
            elSettings = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: 1.0 };
        }
        this.elevenlabsVoiceSettings = elSettings;

        // ---- Feature flags (enable/disable major generators) -----------
        // Defaults: everything ON unless previously disabled.
        const ff = getJSON('hexart_feature_flags', null);
        this.featureFlags = Object.assign({
            imageGen: true,
            videoGen: true,
            ttsGen: true,
            sttGen: true,
            musicGen: true,
            sfxGen: true,         // NEW: ElevenLabs SFX
            svgGen: true,
            imageEdit: true,
            grounding: true,
            renderPreview: true,
            pythonTools: true
        }, ff || {});

        // ---- Tools registry (state for activation/deactivation) --------
        const toolsState = getJSON('hexart_tools_state', null);
        this.toolsState = (toolsState && typeof toolsState === 'object') ? toolsState : {};
        // Custom settings per tool (e.g. ComfyUI port, model paths, etc.)
        const toolsSettings = getJSON('hexart_tools_settings', null);
        this.toolsSettings = (toolsSettings && typeof toolsSettings === 'object') ? toolsSettings : {};

        // ---- Sandbox / paths -------------------------------------------
        this.pythonSandboxPath = getStr('hexart_sandbox_path');     // optional
        this.toolsCachePath = getStr('hexart_tools_cache_path');   // optional

        // ---- LTM -------------------------------------------------------
        let mem = getJSON('aisist_memory_arr', null);
        if (Array.isArray(mem)) {
            this.longTermMemory = mem;
        } else {
            const oldMem = getStr('aisist_memory');
            this.longTermMemory = oldMem && oldMem.length > 20
                ? [{ id: Date.now(), type: 'system', content: oldMem }]
                : [{ id: Date.now(), type: 'system', content: 'Brak specyficznych preferencji. Pamiętaj, by uczyć się na błędach i zapisywać tu zasady!' }];
            diskStorage.setItem('aisist_memory_arr', JSON.stringify(this.longTermMemory));
        }

        // ---- Misc -------------------------------------------------------
        this.useGrounding = diskStorage.getItem('aisist_grounding') !== 'false'
                         && diskStorage.getItem('aisist_grounding') !== false;
        this.customSecrets = getJSON('aisist_custom_secrets', []);
        if (!Array.isArray(this.customSecrets)) this.customSecrets = [];

        this.skillsDir = path.join(os.homedir(), '.aisist_skills');
        this.skills = this.loadSkills();
        this.backgroundProcesses = {};

        // ---- Session attachments — bounded to prevent memory leak ------
        this.sessionAttachments = [];
        this.MAX_SESSION_ATTACHMENTS = 6;     // hard cap
        this.MAX_HISTORY_TURNS = 24;          // chat history cap (was 20)

        this.history = [];
        this.abortController = null;
        this.isAborted = false;

        // ---- Dynamic model caches --------------------------------------
        this._modelCache = {
            gemini: { list: null, ts: 0 },
            openrouter: { list: null, ts: 0 },
            lmstudio: { list: null, ts: 0 }
        };
        this.MODEL_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
    }

    // ---- Provider factory (lazy) ---------------------------------------
    getProvider(kind) {
        const P = window.AfterAllProviders;
        if (!P) throw new Error('AfterAllProviders not loaded.');
        const which = (kind === 'image') ? this.imgProvider : this.llmProvider;
        if (which === 'gemini') return P.create('gemini', { apiKey: this.apiKey });
        if (which === 'openrouter') return P.create('openrouter', { apiKey: this.openrouterApiKey });
        if (which === 'lmstudio') return P.create('lmstudio', { baseUrl: this.lmstudioBaseUrl });
        return P.create('gemini', { apiKey: this.apiKey });
    }

    getActiveLLMModel() {
        switch (this.llmProvider) {
            case 'openrouter': return this.openrouterLLMModel;
            case 'lmstudio':   return this.lmstudioLLMModel;
            default:           return this.geminiModel;
        }
    }
    getActiveImageModel() {
        return this.imgProvider === 'openrouter' ? this.openrouterImageModel : this.geminiImageModel;
    }

    // ---- Dynamic model list with caching -------------------------------
    async fetchModels(providerName, force) {
        const now = Date.now();
        const cache = this._modelCache[providerName];
        if (!force && cache && cache.list && (now - cache.ts) < this.MODEL_CACHE_TTL) {
            return cache.list;
        }
        const P = window.AfterAllProviders;
        if (!P) throw new Error('Providers not loaded');
        let providerInstance;
        if (providerName === 'gemini') providerInstance = P.create('gemini', { apiKey: this.apiKey });
        else if (providerName === 'openrouter') providerInstance = P.create('openrouter', { apiKey: this.openrouterApiKey });
        else if (providerName === 'lmstudio') providerInstance = P.create('lmstudio', { baseUrl: this.lmstudioBaseUrl });
        else throw new Error('Unknown provider: ' + providerName);
        const list = await providerInstance.listLLMModels();
        this._modelCache[providerName] = { list: list, ts: now };
        return list;
    }

    // ---- ElevenLabs lazy client ---------------------------------------
    getElevenLabsClient() {
        const C = window.AfterAllElevenLabs;
        if (!C) throw new Error('AfterAllElevenLabs not loaded.');
        if (!this._elevenLabsClient) this._elevenLabsClient = new C({ apiKey: this.elevenlabsApiKey });
        else this._elevenLabsClient.setApiKey(this.elevenlabsApiKey);
        return this._elevenLabsClient;
    }

    // ---- Feature flag helpers -----------------------------------------
    isFeatureEnabled(name) {
        return this.featureFlags[name] !== false;
    }
    setFeatureFlag(name, value) {
        this.featureFlags[name] = !!value;
        diskStorage.setItem('hexart_feature_flags', JSON.stringify(this.featureFlags));
    }

    // ---- Tools state helpers ------------------------------------------
    isToolEnabled(toolName) {
        // Default to enabled if not in state
        return this.toolsState[toolName] !== false;
    }
    setToolEnabled(toolName, value) {
        this.toolsState[toolName] = !!value;
        diskStorage.setItem('hexart_tools_state', JSON.stringify(this.toolsState));
    }
    getToolSettings(toolName) {
        return this.toolsSettings[toolName] || {};
    }
    setToolSettings(toolName, settings) {
        this.toolsSettings[toolName] = settings || {};
        diskStorage.setItem('hexart_tools_settings', JSON.stringify(this.toolsSettings));
    }

    // List all tools known to the system. Built-in generators + python skills + background processes.
    listAllTools() {
        const tools = [];
        // Built-in generators (feature-flag controlled)
        // Each builtin carries an i18n key pair (labelKey / descKey) — UI resolves
        // them at render time via the i18nDict. The label/description fields below
        // are English fallbacks used only when i18nDict has no entry for the active language.
        const builtins = [
            { name: 'imageGen',      labelKey: 'tool-imageGen-label',      descKey: 'tool-imageGen-desc',      label: 'Image Generator',      kind: 'generator',   icon: '🖼', description: 'Generates images (Gemini / OpenRouter)',                  featureFlag: 'imageGen' },
            { name: 'imageEdit',     labelKey: 'tool-imageEdit-label',     descKey: 'tool-imageEdit-desc',     label: 'Image Editor',         kind: 'generator',   icon: '✂', description: 'Edit / inpainting on existing images',                    featureFlag: 'imageEdit' },
            { name: 'videoGen',      labelKey: 'tool-videoGen-label',      descKey: 'tool-videoGen-desc',      label: 'Video Generator (Grok)', kind: 'generator', icon: '🎬', description: 'Image-to-video via Replicate Grok',                       featureFlag: 'videoGen' },
            { name: 'ttsGen',        labelKey: 'tool-ttsGen-label',        descKey: 'tool-ttsGen-desc',        label: 'Voice Generator (TTS)', kind: 'generator',  icon: '🎙', description: 'Gemini TTS or ElevenLabs TTS',                            featureFlag: 'ttsGen' },
            { name: 'sttGen',        labelKey: 'tool-sttGen-label',        descKey: 'tool-sttGen-desc',        label: 'Transcription (STT)',  kind: 'generator',   icon: '📝', description: 'ElevenLabs Scribe / WhisperX word-level',                 featureFlag: 'sttGen' },
            { name: 'musicGen',      labelKey: 'tool-musicGen-label',      descKey: 'tool-musicGen-desc',      label: 'Music Generator',      kind: 'generator',   icon: '🎵', description: 'Gemini Lyria 3 Pro or ElevenLabs Music (vocals / instrumental)', featureFlag: 'musicGen' },
            { name: 'sfxGen',        labelKey: 'tool-sfxGen-label',        descKey: 'tool-sfxGen-desc',        label: 'Sound Effects (SFX)',  kind: 'generator',   icon: '🔊', description: 'ElevenLabs Text-to-SFX — sounds, ambient (0.5-22s)',     featureFlag: 'sfxGen' },
            { name: 'svgGen',        labelKey: 'tool-svgGen-label',        descKey: 'tool-svgGen-desc',        label: 'SVG Generator',        kind: 'generator',   icon: '✦', description: 'Vector SVG graphics via LLM',                              featureFlag: 'svgGen' },
            { name: 'grounding',     labelKey: 'tool-grounding-label',     descKey: 'tool-grounding-desc',     label: 'Google Search Grounding', kind: 'integration', icon: '🌐', description: 'Live web access for Gemini',                          featureFlag: 'grounding' },
            { name: 'renderPreview', labelKey: 'tool-renderPreview-label', descKey: 'tool-renderPreview-desc', label: 'Render Preview',       kind: 'integration', icon: '📷', description: 'Multi-frame timeline preview for Vision',                 featureFlag: 'renderPreview' },
            { name: 'pythonTools',   labelKey: 'tool-pythonTools-label',   descKey: 'tool-pythonTools-desc',   label: 'Python Environments',  kind: 'integration', icon: '🐍', description: 'venv + pip + git clone + custom scripts',                featureFlag: 'pythonTools' }
        ];
        builtins.forEach(b => {
            tools.push(Object.assign({}, b, {
                enabled: this.isFeatureEnabled(b.featureFlag),
                isBuiltin: true,
                settings: this.getToolSettings(b.name)
            }));
        });
        // Python skills as tools
        try {
            const reg = this.loadSkillsRegistry();
            (reg.skills || []).forEach(s => {
                const toolName = 'pyskill_' + s.name;
                tools.push({
                    name: toolName,
                    label: s.name,
                    kind: 'python_skill',
                    icon: '🧩',
                    description: s.description || 'Python skill (env: ' + s.env + ')',
                    env: s.env,
                    packages: s.packages || [],
                    enabled: this.isToolEnabled(toolName),
                    isBuiltin: false,
                    settings: this.getToolSettings(toolName),
                    createdAt: s.createdAt,
                    raw: s
                });
            });
        } catch (e) { /* ignore */ }
        // Background processes as tools
        Object.keys(this.backgroundProcesses || {}).forEach(name => {
            const p = this.backgroundProcesses[name];
            const toolName = 'bg_' + name;
            tools.push({
                name: toolName,
                label: name + ' (background)',
                kind: 'background',
                icon: '⚙',
                description: 'PID: ' + p.pid + ' · ' + p.status,
                enabled: this.isToolEnabled(toolName),
                isBuiltin: false,
                settings: this.getToolSettings(toolName),
                runtime: { pid: p.pid, status: p.status, isReady: p.isReady, startedAt: p.startedAt }
            });
        });
        return tools;
    }

    // Resolve sandbox path — single source of truth used everywhere.
    getPythonSandboxRoot() {
        if (this.pythonSandboxPath && this.pythonSandboxPath.trim().length > 0) {
            try {
                if (!fs.existsSync(this.pythonSandboxPath)) {
                    fs.mkdirSync(this.pythonSandboxPath, { recursive: true });
                }
                return this.pythonSandboxPath;
            } catch (e) {
                console.error('Custom sandbox path inaccessible, falling back:', e);
            }
        }
        // Default: legacy behaviour — folder next to extension's parent dir
        return path.join(path.dirname(path.dirname(__dirname)), 'python_envs');
    }

    getToolsCacheRoot() {
        if (this.toolsCachePath && this.toolsCachePath.trim().length > 0) {
            try {
                if (!fs.existsSync(this.toolsCachePath)) fs.mkdirSync(this.toolsCachePath, { recursive: true });
                return this.toolsCachePath;
            } catch (e) { /* fall through */ }
        }
        const fallback = path.join(this.getPythonSandboxRoot(), 'cache');
        try { if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true }); } catch(_) {}
        return fallback;
    }

    // Generate safe, descriptive filename slug from a prompt
    promptToSlug(prompt, maxLen) {
        if (!prompt) return 'unnamed';
        maxLen = maxLen || 30;
        return prompt
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')  // remove non-alphanumeric
            .trim()
            .split(/\s+/)               // split words
            .slice(0, 5)                // max 5 words
            .join('_')
            .substring(0, maxLen) || 'unnamed';
    }

    // --- Python Environment Tool ---
    async runPythonTask(taskDef, updateStatusCallback) {
        if (!this.isFeatureEnabled('pythonTools')) {
            return { error: 'Środowiska Python są wyłączone w ustawieniach (Ogólne → Funkcje).' };
        }
        const { exec } = require('child_process');
        const path = require('path');
        const fsNode = require('fs');

        const envName = (taskDef.env || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_');
        const envsDir = this.getPythonSandboxRoot();
        const envDir = path.join(envsDir, envName);
        const isWin = process.platform === 'win32';
        const pythonBin = isWin ? path.join(envDir, 'Scripts', 'python.exe') : path.join(envDir, 'bin', 'python');
        const pipBin = isWin ? path.join(envDir, 'Scripts', 'pip.exe') : path.join(envDir, 'bin', 'pip');
        
        const self = this;
        const runCmd = (cmd, cwd) => {
            return new Promise((resolve) => {
                if (self.isAborted) { resolve({ success: false, stdout: '', stderr: 'Aborted by user', code: -1 }); return; }
                const opts = { maxBuffer: 16 * 1024 * 1024, timeout: 300000, windowsHide: true };
                if (cwd) opts.cwd = cwd;
                const child = exec(cmd, opts, (err, stdout, stderr) => {
                    resolve({ success: !err, stdout: (stdout || '').substring(0, 8000), stderr: (stderr || '').substring(0, 4000), code: err ? err.code : 0 });
                });
                // Hook abort: kill the child if user aborts mid-task
                const abortCheck = setInterval(() => {
                    if (self.isAborted && child && !child.killed) {
                        try { child.kill('SIGTERM'); } catch(_) {}
                        clearInterval(abortCheck);
                    }
                }, 500);
                child.on('exit', () => clearInterval(abortCheck));
            });
        };

        try {
            // Ensure base directory exists
            if (!fsNode.existsSync(envsDir)) fsNode.mkdirSync(envsDir, { recursive: true });
            
            let results = [];
            
            // Step 1: Create venv if it doesn't exist
            if (!fsNode.existsSync(pythonBin)) {
                updateStatusCallback('Tworzenie srodowiska Python: ' + envName + '...');
                const createResult = await runCmd('python -m venv "' + envDir + '"');
                if (!createResult.success) {
                    return { error: 'Nie udalo sie stworzyc venv: ' + createResult.stderr };
                }
                results.push({ step: 'venv_create', status: 'ok', env: envName });
            } else {
                results.push({ step: 'venv_exists', status: 'ok', env: envName });
            }
            
            // Step 2: Install packages
            if (taskDef.packages && taskDef.packages.length > 0) {
                updateStatusCallback('Instalowanie pakietow: ' + taskDef.packages.join(', ') + '...');
                const pkgList = taskDef.packages.join(' ');
                const installResult = await runCmd('"' + pipBin + '" install ' + pkgList);
                results.push({ step: 'pip_install', packages: taskDef.packages, success: installResult.success, output: installResult.stdout.substring(0, 500) });
                if (!installResult.success) {
                    results.push({ step: 'pip_error', stderr: installResult.stderr });
                }
            }
            
            // Step 3: Clone git repos
            if (taskDef.git_repos && taskDef.git_repos.length > 0) {
                for (const repo of taskDef.git_repos) {
                    const repoUrl = typeof repo === 'string' ? repo : repo.url;
                    const repoName = repoUrl.split('/').pop().replace('.git', '');
                    const repoDir = path.join(envDir, 'repos', repoName);
                    
                    if (!fsNode.existsSync(path.join(envDir, 'repos'))) {
                        fsNode.mkdirSync(path.join(envDir, 'repos'), { recursive: true });
                    }
                    
                    if (fsNode.existsSync(repoDir)) {
                        updateStatusCallback('Aktualizowanie repo: ' + repoName + '...');
                        const pullResult = await runCmd('git pull', repoDir);
                        results.push({ step: 'git_pull', repo: repoName, success: pullResult.success });
                    } else {
                        updateStatusCallback('Klonowanie repo: ' + repoName + '...');
                        const cloneResult = await runCmd('git clone "' + repoUrl + '" "' + repoDir + '"');
                        results.push({ step: 'git_clone', repo: repoName, success: cloneResult.success, path: repoDir });
                    }
                    
                    // Install repo requirements if present
                    const reqFile = path.join(repoDir, 'requirements.txt');
                    if (fsNode.existsSync(reqFile)) {
                        updateStatusCallback('Instalowanie requirements.txt z ' + repoName + '...');
                        await runCmd('"' + pipBin + '" install -r "' + reqFile + '"');
                    }
                }
            }
            
            // Step 4: Run script
            if (taskDef.script) {
                updateStatusCallback('Uruchamiam skrypt Python...');
                const scriptPath = path.join(envDir, 'script_' + Date.now() + '.py');
                fsNode.writeFileSync(scriptPath, taskDef.script, 'utf8');
                
                let cwd = taskDef.cwd || envDir;
                const scriptResult = await runCmd('"' + pythonBin + '" "' + scriptPath + '"', cwd);
                results.push({ step: 'run_script', success: scriptResult.success, stdout: scriptResult.stdout, stderr: scriptResult.stderr });
                
                // Clean up temp script
                try { fsNode.unlinkSync(scriptPath); } catch(e) {}
            }
            
            // Step 5: Run command directly
            if (taskDef.command) {
                updateStatusCallback('Uruchamiam komende: ' + taskDef.command.substring(0, 50) + '...');
                let cwd = taskDef.cwd || envDir;
                // Activate venv prefix
                const activatePrefix = isWin 
                    ? '"' + path.join(envDir, 'Scripts', 'activate.bat') + '" && '
                    : 'source "' + path.join(envDir, 'bin', 'activate') + '" && ';
                const cmdResult = await runCmd(activatePrefix + taskDef.command, cwd);
                results.push({ step: 'run_command', success: cmdResult.success, stdout: cmdResult.stdout, stderr: cmdResult.stderr });
            }
            
            // Step 6: Start background process (non-blocking)
            if (taskDef.background) {
                const { spawn } = require('child_process');
                const bgName = taskDef.background_name || taskDef.env || 'bg_' + Date.now();
                
                // Dedup: check if process with same name already running
                if (this.backgroundProcesses[bgName] && this.isProcessRunning(bgName)) {
                    updateStatusCallback('Proces "' + bgName + '" juz dziala (PID:' + this.backgroundProcesses[bgName].pid + ')');
                    results.push({ step: 'background_already_running', name: bgName, pid: this.backgroundProcesses[bgName].pid, isReady: this.backgroundProcesses[bgName].isReady });
                } else {
                    const bgCmd = taskDef.background_cmd || taskDef.command;
                    if (!bgCmd) {
                        results.push({ step: 'background_error', error: 'Brak background_cmd' });
                    } else {
                        updateStatusCallback('Uruchamiam proces w tle: ' + bgName + '...');
                        const bgCwd = taskDef.cwd || envDir;
                        
                        // Parse command into parts
                        const isFullPath = bgCmd.includes('\\') || bgCmd.includes('/');
                        let child;
                        if (isWin) {
                            child = spawn('cmd.exe', ['/c', bgCmd], {
                                cwd: bgCwd,
                                detached: true,
                                stdio: ['ignore', 'pipe', 'pipe'],
                                windowsHide: true
                            });
                        } else {
                            child = spawn('sh', ['-c', bgCmd], {
                                cwd: bgCwd,
                                detached: true,
                                stdio: ['ignore', 'pipe', 'pipe']
                            });
                        }
                        
                        const readyKeyword = taskDef.ready_keyword || null;
                        const bgEntry = {
                            pid: child.pid,
                            status: 'starting',
                            lastOutput: '',
                            startedAt: Date.now(),
                            readyKeyword: readyKeyword,
                            isReady: false,
                            childRef: child
                        };
                        this.backgroundProcesses[bgName] = bgEntry;
                        
                        // Watch stdout for ready keyword
                        child.stdout.on('data', (data) => {
                            const text = data.toString();
                            bgEntry.lastOutput = text.substring(0, 500);
                            bgEntry.status = 'running';
                            if (readyKeyword && text.toLowerCase().includes(readyKeyword.toLowerCase())) {
                                bgEntry.isReady = true;
                                bgEntry.status = 'ready';
                            }
                        });
                        
                        child.stderr.on('data', (data) => {
                            const text = data.toString();
                            bgEntry.lastOutput = text.substring(0, 500);
                            // Some apps output to stderr (e.g. Python logging)
                            if (readyKeyword && text.toLowerCase().includes(readyKeyword.toLowerCase())) {
                                bgEntry.isReady = true;
                                bgEntry.status = 'ready';
                            }
                        });
                        
                        child.on('close', (code) => {
                            bgEntry.status = 'exited (' + code + ')';
                        });
                        
                        child.on('error', (err) => {
                            bgEntry.status = 'error: ' + err.message;
                        });
                        
                        // If ready_keyword provided, wait up to 60s for it
                        if (readyKeyword) {
                            updateStatusCallback('Czekam na gotowość: "' + readyKeyword + '"...');
                            for (let w = 0; w < 30; w++) {
                                await new Promise(r => setTimeout(r, 2000));
                                if (bgEntry.isReady) {
                                    updateStatusCallback(bgName + ' gotowy!');
                                    break;
                                }
                                if (bgEntry.status.startsWith('exited') || bgEntry.status.startsWith('error')) {
                                    break;
                                }
                            }
                        } else {
                            // No keyword — just wait 3s for startup then return
                            await new Promise(r => setTimeout(r, 3000));
                        }
                        
                        results.push({
                            step: 'background_started',
                            name: bgName,
                            pid: child.pid,
                            status: bgEntry.status,
                            isReady: bgEntry.isReady,
                            lastOutput: bgEntry.lastOutput
                        });
                        
                        child.unref(); // Don't block Node exit
                    }
                }
            }

            
            // Save env metadata
            const metaPath = path.join(envDir, 'env_meta.json');
            let meta = {};
            if (fsNode.existsSync(metaPath)) {
                try { meta = JSON.parse(fsNode.readFileSync(metaPath, 'utf8')); } catch(e) {}
            }
            meta.name = envName;
            meta.lastUsed = new Date().toISOString();
            if (taskDef.packages) meta.packages = [...new Set([...(meta.packages || []), ...taskDef.packages])];
            if (taskDef.git_repos) meta.repos = [...new Set([...(meta.repos || []), ...taskDef.git_repos.map(r => typeof r === 'string' ? r : r.url)])];
            fsNode.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
            
            return { success: true, env: envName, envPath: envDir, results: results };
        } catch (err) {
            console.error('Python task error:', err);
            return { error: err.message };
        }
    }
    
    // List available Python environments
    async listPythonEnvs() {
        const path = require('path');
        const fsNode = require('fs');
        const envsDir = this.getPythonSandboxRoot();
        if (!fsNode.existsSync(envsDir)) return { envs: [] };
        
        const dirs = fsNode.readdirSync(envsDir, { withFileTypes: true }).filter(d => d.isDirectory());
        const envs = [];
        for (const dir of dirs) {
            const metaPath = path.join(envsDir, dir.name, 'env_meta.json');
            let meta = { name: dir.name };
            if (fsNode.existsSync(metaPath)) {
                try { meta = JSON.parse(fsNode.readFileSync(metaPath, 'utf8')); } catch(e) {}
            }
            envs.push(meta);
        }
        return { envs: envs };
    }

    // --- WhisperX Word-Level Transcription Tool ---
    async transcribeWhisperX(audioSource, updateStatusCallback) {
        if (!this.isFeatureEnabled('sttGen')) {
            return { error: 'Speech-to-Text jest wyłączony w ustawieniach.' };
        }
        const fsNode = require('fs');
        const pathNode = require('path');
        
        // Resolve audio source
        let audioPath = audioSource;
        if (audioSource === 'last_audio' || audioSource === 'last_tts') {
            if (this.lastGeneratedAudioPaths && this.lastGeneratedAudioPaths.length > 0) {
                audioPath = this.lastGeneratedAudioPaths[this.lastGeneratedAudioPaths.length - 1];
            } else {
                return { error: 'Brak wygenerowanego pliku audio (last_audio). Najpierw wygeneruj TTS.' };
            }
        }
        
        if (!fsNode.existsSync(audioPath)) {
            return { error: 'Plik audio nie istnieje: ' + audioPath };
        }
        
        updateStatusCallback('WhisperX: Przygotowuję transkrypcję word-level...');
        
        // Output JSON path
        const outputDir = pathNode.dirname(audioPath);
        const baseName = pathNode.basename(audioPath, pathNode.extname(audioPath));
        const jsonPath = pathNode.join(outputDir, baseName + '_whisperx.json');
        
        // Python script for WhisperX transcription
        const script = `
import sys
import json
import os

audio_path = r"${audioPath.replace(/\\/g, '\\\\')}"
output_path = r"${jsonPath.replace(/\\/g, '\\\\')}"

try:
    import whisper
    model = whisper.load_model("base")
    result = model.transcribe(audio_path, word_timestamps=True)
    
    words = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []):
            words.append({
                "word": word["word"].strip(),
                "start": round(word["start"], 3),
                "end": round(word["end"], 3)
            })
    
    output = {
        "text": result.get("text", ""),
        "language": result.get("language", "unknown"),
        "word_count": len(words),
        "words": words
    }
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print("SUCCESS:" + str(len(words)) + " words")
    print("OUTPUT:" + output_path)
    
except Exception as e:
    print("ERROR:" + str(e), file=sys.stderr)
    sys.exit(1)
`;
        
        // Run via Python env
        const result = await this.runPythonTask({
            env: 'whisperx_tool',
            packages: ['openai-whisper', 'torch', 'torchaudio'],
            script: script
        }, updateStatusCallback);
        
        if (result.error) {
            return { error: 'WhisperX error: ' + result.error };
        }
        
        // Parse results
        const scriptResult = result.results.find(r => r.step === 'run_script');
        if (!scriptResult || !scriptResult.success) {
            return { error: 'WhisperX script failed: ' + (scriptResult ? scriptResult.stderr : 'no output') };
        }
        
        // Read the JSON output
        if (fsNode.existsSync(jsonPath)) {
            try {
                const jsonData = JSON.parse(fsNode.readFileSync(jsonPath, 'utf8'));
                updateStatusCallback('WhisperX: ' + jsonData.word_count + ' slow z timestampami');
                return {
                    success: true,
                    jsonPath: jsonPath,
                    wordCount: jsonData.word_count,
                    language: jsonData.language,
                    text: jsonData.text,
                    words: jsonData.words,
                    message: 'WhisperX transkrypcja: ' + jsonData.word_count + ' slow, jezyk: ' + jsonData.language
                };
            } catch(e) {
                return { error: 'Nie udalo sie odczytac JSON: ' + e.message };
            }
        } else {
            return { error: 'WhisperX nie wygenerował pliku JSON: ' + jsonPath + '. stdout: ' + scriptResult.stdout };
        }
    }




    abortProcess() {
        if (this.abortController) {
            this.abortController.abort("Przerwane przez użytkownika.");
            this.isAborted = true;
        }
    }

    // --- Custom Secrets ---
    getSecretByName(name) {
        const s = this.customSecrets.find(s => s.name.toLowerCase() === name.toLowerCase());
        return s ? s.key : null;
    }

    // --- Skills System ---
    loadSkills() {
        try {
            if (!fs.existsSync(this.skillsDir)) {
                fs.mkdirSync(this.skillsDir, { recursive: true });
            }
            // Load markdown skills
            const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.md'));
            const mdSkills = files.map(f => {
                const content = fs.readFileSync(path.join(this.skillsDir, f), 'utf8');
                const firstLine = content.split('\n')[0].replace(/^#+\s*/, '').trim();
                return { name: f.replace('.md', ''), title: firstLine, content: content, type: 'markdown' };
            });
            // Load Python registry skills
            const registry = this.loadSkillsRegistry();
            const pySkills = registry.skills.map(s => ({
                name: s.name,
                title: s.description || s.name,
                content: 'Python Skill: ' + s.name + '\nEnv: ' + s.env + '\nPackages: ' + (s.packages || []).join(', ') + '\nCreated: ' + s.createdAt,
                type: 'python',
                env: s.env,
                packages: s.packages
            }));
            return [...mdSkills, ...pySkills];
        } catch(e) {
            console.error('Skills load error:', e);
            return [];
        }
    }

    saveSkill(name, content) {
        try {
            if (!fs.existsSync(this.skillsDir)) {
                fs.mkdirSync(this.skillsDir, { recursive: true });
            }
            const safeName = name.replace(/[^a-zA-Z0-9_\-\sąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, '').replace(/\s+/g, '_');
            fs.writeFileSync(path.join(this.skillsDir, safeName + '.md'), content, 'utf8');
            this.skills = this.loadSkills();
            return true;
        } catch(e) {
            console.error('Skill save error:', e);
            return false;
        }
    }

    deleteSkill(name) {
        try {
            // Try markdown skill
            const filePath = path.join(this.skillsDir, name + '.md');
            if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
            // Try Python skill
            const registry = this.loadSkillsRegistry();
            const idx = registry.skills.findIndex(s => s.name === name);
            if (idx >= 0) {
                registry.skills.splice(idx, 1);
                const regPath = this.getSkillsRegistryPath();
                fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf8');
            }
            this.skills = this.loadSkills();
            return true;
        } catch(e) { return false; }
    }

    get systemInstruction() {
        const langRule = this.projectLanguage === 'auto'
            ? "Język Projektu 'Auto': Samodzielnie rozpoznaj język naturalny z prompta użytkownika (i LTM) i zmuś się by WSZYSTKIE kreowane teksty (nazwy warstw, kompozycje, tts, napisy) były w tym samym języku co prompt!"
            : `Język Projektu wymuszony: '${this.projectLanguage.toUpperCase()}'. BEZWZGLĘDNIE produkuj treść (teksty na ekranie, nazwy warstw, głos lektora) w tym języku, niezależnie od języka użytego przez użytkownika w zapytaniu (tłumacz polecenia w locie).`;

        const voiceRule = this.ttsVoice === 'Auto'
            ? "Głos lektora to 'Auto'. W 'parallel_tasks.tts' DODAJ sam imię postaci (Puck, Charon, Kore, Fenrir, Aoede) na początku np. 'Puck: Treść', dobierając głos do ogólnego nastroju kompozycji!"
            : `Głos lektora to '${this.ttsVoice}'. Zawsze dodawaj '${this.ttsVoice}: ' na początku tekstów tts.`;

        const providerNote = '\n### AKTYWNY DOSTAWCA AI:'
            + '\n- LLM: ' + this.llmProvider + ' (model: ' + this.getActiveLLMModel() + ')'
            + '\n- Obrazy: ' + this.imgProvider + ' (model: ' + this.getActiveImageModel() + ')'
            + '\n- TTS: ' + (this.ttsProvider === 'elevenlabs' ? 'ElevenLabs (' + this.elevenlabsModel + ')' : 'Gemini (' + this.ttsModel + ')')
            + '\n- Music: ' + (this.musicProvider === 'elevenlabs' ? 'ElevenLabs Eleven Music (z vocals / instrumental)' : 'Gemini Lyria 3 Pro (instrumental)')
            + '\n- SFX: ElevenLabs Text-to-Sound-Effects (parallel_tasks.sfx)'
            + (this.llmProvider !== 'gemini' ? '\n- UWAGA: Aktywny dostawca LLM to NIE Gemini — niektóre funkcje (Google Search Grounding, native vision dla SVG) mogą być ograniczone. Generuj kod ExtendScript jak zawsze; system sandbox zadziała tak samo.' : '');

        // Surface feature flags so the agent doesn't request disabled features
        const disabled = Object.keys(this.featureFlags).filter(k => !this.featureFlags[k]);
        const featureNote = disabled.length > 0
            ? '\n### ⚠ WYŁĄCZONE FUNKCJE (NIE UŻYWAJ): ' + disabled.join(', ') + '. Jeśli zadanie wymaga którejś z nich — poproś użytkownika o włączenie w Ustawieniach.'
            : '';

        // Surface ElevenLabs voice config for the agent
        const elevenNote = (this.ttsProvider === 'elevenlabs') ?
            ('\n### ELEVENLABS TTS:'
                + '\n- Domyślny głos: ' + (this.elevenlabsUseGeneralDefault ? this.elevenlabsDefaultVoice : '(automatyczny po płci)')
                + '\n- Głos męski: ' + (this.elevenlabsMaleVoice || 'NIEUSTAWIONY')
                + '\n- Głos żeński: ' + (this.elevenlabsFemaleVoice || 'NIEUSTAWIONY')
                + '\n- W prompcie TTS użyj prefiksu "Male:" lub "Female:" by wybrać płeć (np. "Female: Witam państwa..."). Bez prefiksu — domyślny głos.')
            : '';

        // Surface asset snapshot & permissions context to teach the agent which items are PROTECTED
        let assetNote = '';
        if (this._assetTracker && this._assetTracker.snapshot) {
            const snap = this._assetTracker.snapshot;
            const items = (snap.items || []).slice(0, 40);
            const compsList = Object.keys(snap.layers || {}).slice(0, 15);
            assetNote = '\n### ⚠ CHRONIONE DANE UŻYTKOWNIKA (snapshot przy starcie zadania):'
                + '\n- KATEGORYCZNIE NIE USUWAJ żadnego z poniższych elementów ani warstw bez wyraźnej, ZATWIERDZONEJ przez użytkownika prośby!'
                + '\n- Items (' + items.length + (snap.items && snap.items.length > 40 ? '+' : '') + '): ' + items.join(', ')
                + '\n- Comps z warstwami: ' + compsList.join(', ')
                + '\n- Pliki tymczasowe (prefix aisist_*) MOŻESZ swobodnie usuwać/edytować — to TWOJE assety.'
                + '\n- Jeśli musisz "zastąpić" coś z chronionych — zduplikuj i wyłącz oryginał (enabled=false) zamiast usuwać.'
                + '\n- Jeśli MUSISZ usunąć chroniony element: ZAPLANUJ to w current_plan z wyraźnym ostrzeżeniem ("⚠ wymaga zgody usera"), następnie zażądaj zgody przez questions_for_user PRZED napisaniem kodu z .remove().';
        }
        const permRulesActive = (this._permManager && this._permManager.list && this._permManager.list().length) || 0;
        if (permRulesActive > 0) {
            assetNote += '\n- Aktywne reguły uprawnień: ' + permRulesActive + ' (user już zdecydował dla niektórych operacji).';
        }

        return `
Jesteś autonomicznym agentem AI - ekspertem Senior Motion Designerem i programistą ExtendScript dla Adobe After Effects.${providerNote}${featureNote}${elevenNote}${assetNote}

### TWOJA ROLA JAKO ORKIESTRATOR (KRYTYCZNE):
Jesteś **inteligentnym dyrygentem zadań** — nie tylko wykonujesz, ale aktywnie PLANUJESZ, OBSERWUJESZ STAN, REPLANIRUJESZ gdy zmienia się sytuacja i decydujesz CO można zrobić RÓWNOLEGLE a CO musi być SEKWENCYJNE.

- **Najpierw plan, potem akcja**: każda Twoja odpowiedź zawiera "current_plan" — listę kroków z wyraźnym oznaczeniem statusu (Gotowe / Aktualnie / Zaplanowane / ⚠ wymaga zgody usera).
- **Maksymalizuj równoległość**: zasoby niezależne od siebie (np. obraz #1, obraz #2, obraz #3) UMIESZCZAJ w jednym kroku w parallel_tasks.images — system uruchomi je naraz. Sekwencyjnie tylko gdy jest zależność (TTS → muzyka pod TTS, obraz → wideo z obrazu).
- **Replanowanie**: gdy w kontekście pojawia się błąd, niespodzianka, lub odpowiedź od użytkownika zmieniająca założenia — JAWNIE zaktualizuj current_plan w następnej iteracji ("Krok X: ANULOWANO — zmiana planu", "Nowy Krok Y").
- **Komunikacja procesu**: w polu "message" pisz ELOKWENTNIE i naturalnie po polsku — opisuj CO ROBISZ i DLACZEGO. Użytkownik widzi to w chacie obok wizualizacji Pipeline (pasek postępu, parallelowe karty zadań). Twoja narracja uzupełnia wizualizację.
- **Krótkie pochwały tylko gdy ma sens** — nie spamuj "świetnie!", "doskonale!". Lepiej: konkretny komunikat co dalej.

### RESEARCH NARZĘDZI I BIBLIOTEK (KRYTYCZNE):
${this.useGrounding && this.llmProvider === 'gemini' ? '- Masz WŁĄCZONY Google Search Grounding — UŻYWAJ GO PROAKTYWNIE.' : '- Google Search Grounding nieaktywny dla tego providera/modelu — research przez Python (requests + BeautifulSoup) lub własną wiedzę.'}
- Zanim napiszesz kod od zera: SPRAWDŹ czy istnieje biblioteka Python która już to robi (PyPI, GitHub).
- Przykłady proaktywnego researchu: "Czy istnieje biblioteka X do tej generacji?" → search → jeśli tak, klonuj/instaluj → zapisz jako skill.
- Po odkryciu/instalacji potężnego narzędzia ZAWSZE zapisz je przez save_as_skill — będzie dostępne w kolejnych zadaniach bez ponownej instalacji.
- Patrz najpierw na TWOJE ZAPISANE SKILLE (sekcja niżej) — może już masz to co potrzebne.

### ZAKAZ USUWANIA BEZ ZGODY (KRYTYCZNE — przeczytaj UWAŻNIE):
- **Domyślnie NIE usuwaj NICZEGO** co istniało w projekcie PRZED startem Twojego zadania (zobacz sekcję CHRONIONE DANE wyżej).
- Pliki/warstwy z prefiksem \`aisist_*\` są TYMCZASOWE (Twoje wytwory) — możesz je usuwać i nadpisywać swobodnie.
- Gdy usunięcie chronionego elementu jest naprawdę potrzebne:
   1. NAPISZ to JAWNIE w current_plan: \`"Krok N: ⚠ Usunięcie warstwy X — WYMAGA ZGODY USERA"\`
   2. Zapytaj questions_for_user: \`{"question": "Czy mam usunąć warstwę X?", "suggestion": "Zostawiam — zduplikuję i wyłączę oryginał"}\`
   3. DOPIERO po akceptacji wygeneruj kod z .remove()
- Lepsze alternatywy: \`layer.enabled = false\` (ukrycie), \`layer.duplicate()\` (kopia robocza), zmiana nazwy z prefiksem \`_old_\`.
- System ma osobne uprawnienia per operacja — jeśli usuniesz coś bez zgody, system Cię zablokuje i wymusi alternatywę.
Tworzysz WYSOKIEJ JAKOŚCI, kreatywne, zaawansowane skrypty (.jsx), które modyfikują projekt, kompozycje i warstwy. Cel zadania to Twój priorytet! Zrób to najlepiej i najładniej jak potrafisz.
Masz zaprogramowaną niezwykłą dbałość o detale i estetykę, domyślnie projektujesz wielowarstwowe kompozycje, używasz obiektów Null, Track Matte'ów, zaawansowanych Expressions oraz prekompozycji, by osiągnąć kinowy, 'Premium' efekt. NIE ograniczaj się z ilością pracy - orkiestruj skomplikowane i wieloetapowe zadania tak dogłębnie, jak to potrzebne. Aktualizuj plan (current_plan) w locie, w zależności od ewoluujących potrzeb, ale nie trać ostatecznego celu z oczu. Oczekuję, że z własnej inicjatywy będziesz automatycznie ulepszał kompozycje wykorzystując wszystkie dostępne Ci modele (wliczając Grok i Muzykę).

### USTAWIENIA PROJEKTU (INTERNACJONALIZACJA I GŁOSY):
- ${langRule}
- ${voiceRule}

### TWOJA PAMIĘĆ DŁUGOTERMINOWA (LTM):
Oto Twoja pamiec dlugoterminowa pogrupowana wg KATEGORII (najnowsze wpisy pierwsze). Operacje: "add" (nowy wpis z category), "update" (zmien tresc istniejacego ID), "replace_category" (zastap WSZYSTKIE wpisy w danej kategorii jednym nowym), "delete" (usun po ID), "delete_category" (usun cala kategorie). Przyklad: {"action":"replace_category","category":"extendscript_errors","content":"moveToBack nie istnieje - uzyj moveTo(n)"}. ZAWSZE podawaj "category" przy dodawaniu wpisow! Kategorie np: extendscript_errors, user_preferences, workflow_patterns, project_notes, tool_configs.
"""
${this.formatLTMForPrompt()}
"""

${this.useGrounding ? "### DOSTĘP W CZASIE RZECZYWISTYM (GROUNDING):\nMasz WŁĄCZONE narzędzie Google Search ('google_search'). ZANIM zaczniesz generować obrazy (prompty) i pisać kod nt. określonego zjawiska, przedmiotu lub osoby, OBOWIĄZKOWO uderz do wyszukiwarki (wykorzystując narzędzie!) by pobrać szczegółowe fakty, opisy wyglądu zewnętrznego, historię i inspiracje. Twoje prompty na obrazy muszą być super rzetelne i unikatowe (unikaj repetetywnych fraz dzięki wyszukanej wiedzy)!" : ""}

${this.customSecrets.length > 0 ? `### CUSTOM API SECRETS (Dostępne klucze API):
Użytkownik udostępnił Ci następujące klucze API. Możesz ich używać w kodzie (fetch) do integracji z zewnętrznymi serwisami. KLUCZE SĄ DOSTĘPNE PO STRONIE NODE.JS POZA AE! Jeśli musisz ich użyć, poprosi o specjalną obsługę w parallel_tasks lub dodaj komentarz w message.
${this.customSecrets.map(s => `- **${s.name}**: (klucz zapisany, dostępny pod nazwą '${s.name}')`).join('\n')}` : ""}

${this.skills.length > 0 ? `### BIBLIOTEKA UMIEJĘTNOŚCI (Skills):
Masz dostęp do następujących gotowych przepisów/technik. ZANIM zaczniesz pisać kod od zera, sprawdź czy któryś skill pasuje do zadania — jeśli tak, zastosuj go jako bazę!
${this.skills.map(s => `- **${s.name}**: ${s.title}`).join('\n')}
Aby odczytać pełną treść skilla, użyj nowego klucza JSON "load_skill": "nazwa_skilla". Aby zapisać nowy skill po ukończeniu zadania, użyj "save_skill": {"name": "Nazwa", "content": "# Tytuł\\nOpis przepisu..."}` : ""}

### GOTOWE EXPRESSION PRESETS (sprawdzone - uzywaj zamiast pisac od zera!):
${Object.entries(this.expressionPresets).map(([name, expr]) => '- **' + name + '**: `' + expr + '`').join('\n')}

Twój format odpowiedzi MUSI być wyłącznie obiektem JSON. Nie dodawaj markdowna poza JSON-em.
{
  "thought": "Twoje szczegółowe przemyślenia, analiza problemu i decyzje reżyserskie na dany krok.",
  "current_plan": ["Krótko: Krok 1 (Gotowe)", "Krok 2: Generowanie Assetów (Aktualnie)", "Krok 3: Oskryptowanie..."],
  "code": ["KOD ZAWSZE JAKO BARDZO KRÓTKA TABLICA STRINGÓW!", "Każdy wiersz kodu to osobny element tablicy.", "Zostaw puste [], jeśli omijasz ten krok."],
  "parallel_tasks": {
    "images": ["Opcjonalnie: Prompt 1 na obraz", "Prompt 2 jeśli chcesz wiele..."],
    "tts": ["Opcjonalnie: Prompt na lektora 1", "Prompt na lektora 2..."],
    "video_grok": [{"prompt": "Instrukcja wideo dla Replicate/Grok. PRO-TIP: Ożywiaj wygenerowane obrazy poleceniami Action/Camera!", "source": "Np. 'last_image_0', 'last_image_1' odnosi się do konkretnych obrazów z listy wygenerowanej w tym lub poprzednim kroku.", "duration": "5", "aspect_ratio": "16:9"}],
    "music": ["Opcjonalnie: Epic instrumental cinematic background music by Hans Zimmer"],
    "sfx": [{"prompt": "Opcjonalnie: cinematic whoosh, deep impact reverb tail", "duration_seconds": 3, "prompt_influence": 0.4}],
    "transcribe_audio": [{"source": "Opcjonalnie: last_audio"}]
  },
  "questions_for_user": [
    { "question": "Widzę, że nie wspomniałeś o kolorystyce. Jaki przewodni kolor interfejsu preferujesz?", "suggestion": "Użyjmy nowoczesnego neonowego niebieskiego i ciemnego tła." }
  ],
  "message": "Twój bezpośredni kontakt z użytkownikiem. ZASADY: 1) NIGDY nie odpytuj o klatkaż czy rozdzielczość - bezwzględnie przyjmuj domyślnie 1920x1080 30fps. Bądź maksymalnie samodzielny! Użyj tablicy 'questions_for_user' TYLKO w ostateczności (gdy polecenie jest nielogiczne lub brakuje wizji artystycznej). Zawsze proponuj najlepsze rozwiązanie (sugestię), by użytkownik mógł to zatwierdzić bez pisania asystentowi odpowiedzi. Zwrócenie pytań zatrzymuje Twój proces (Kod JSX się w tym kroku nie wywoła). 2) Bądź niezwykle zwięzły. 3) Twórz fascynujace krotkie podsumowanie wykonanej pracy gdy is_task_complete wynosi true. OBOWIAZKOWE! Puste message + is_task_complete:true jest ZAKAZANE.",
  "attach_files": [{"path": "D:/projects/test/image.png", "label": "Referencja"}],
  "is_task_complete": false
}

Zasady i Ostrzeżenia:
1. Zawsze musisz wyprowadzić poprawny JSON. 
2. Orkiestracja równoległa: Generowanie zasobów (parallel_tasks) z tego JSONa wykona się w tle ZANIM podany tu kod "code" wejdzie do AE. Dlatego jeśli chcesz pracować skryptem OPIERAJĄC się na grafice lub lektorze zdefiniowanych w \`parallel_tasks\`, najlepiej w obecnym kroku zostaw \`code\` puste, ustaw \`is_task_complete: false\`. A w KOLEJNYM sygnale wyślij dopiero \`code\`, bazując na tym co już wyląduje w Projekcie (będzie w app.project.item).
3. PAMIĘTAJ! Jeśli wygenerowałeś obraz (images) lub lektora (tts) we wcześniejszym kroku, są one JUŻ w okienku Project! W Kodzie musisz napisać pętlę po \`app.project.items\`, odnaleźć je (szukaj po nazwie zawierającej ciąg 'aisist_gen_' lub 'aisist_tts_') i OBOWIĄZKOWO dodać jako warstwy \`currentComp.layers.add(...)\` do kompozycji! Nigdy nie ignoruj stworzonych przez Ciebie zasobów.
4. OBOWIĄZKOWA WERYFIKACJA WIZUALNA: Jeśli nakładasz skomplikowane efekty lub układasz grafiki, Twój przedostatni JSON musi wypuścić wygenerowany kod, ale wciąż z \`is_task_complete: false\`. W kolejnej iteracji otrzymasz prawdziwy Zrzut Ekranu (Vision). Obejrzyj go dokładnie. Dopiero gdy wizualnie upewnisz się, że jest dobrze, oddaj pusty kod z \`is_task_complete: true\`.
5. NIEZAPISANY PROJEKT: W After Effects \`app.project.file\` bardzo często bywa równe \`null\`, jeśli użytkownik nie zapisał nowo otwartego projektu! Wszelkie odwołania jak np. \`app.project.file.parent\` spowodują fatalny błąd skryptu! ZAKAZUJĘ Ci używania \`app.project.file\`. Wszystkie potrzebne Twoje assety leżą już w \`app.project.item\`.
6. OTWARCIE KOMPOZYCJI: Kiedy stworzysz nową kompozycję (np. \`addComp\`), pod koniec swojego skryptu OBOWIĄZKOWO wywołaj \`twojaKompozycja.openInViewer();\`. W przeciwnym razie system weryfikacji wizualnej (Vision) nie będzie potrafił zrobić zrzutu ekranu z jej zawartości!
7. UNDO GROUP (KRYTYCZNE - przeczytaj uważnie!):
   (a) WRAPPER WYKONUJĄCY TWÓJ KOD JUŻ WYWOŁUJE \`app.beginUndoGroup("HEXART.PL/AfterALL Action")\` PRZED Twoim kodem i \`app.endUndoGroup()\` PO. Twój kod nie musi (i NIE POWINIEN) tego robić.
   (b) NIGDY nie wywołuj \`app.beginUndoGroup(...)\` NA POCZĄTKU swojego skryptu - powoduje to ZAGNIEŻDŻENIE grup, przez co użytkownik musi nacisnąć Ctrl+Z wielokrotnie aby cofnąć jeden krok.
   (c) NIGDY nie wywołuj \`app.endUndoGroup()\` w swoim kodzie BEZ poprzedzającego, własnego \`beginUndoGroup\`. Zamknie to grupę wrappera i kolejne operacje wylądują w niezdefiniowanej grupie - rozbije to czystość historii.
   (d) Jeśli MUSISZ logicznie podzielić swój krok na pod-operacje (rzadkie!): otaczaj je PARAMI \`app.beginUndoGroup("Sub-action")\` + \`app.endUndoGroup()\`, ZAWSZE w jednym bloku try/finally aby endUndoGroup nigdy nie został pominięty:
        try { app.beginUndoGroup("Subop"); /* ... */ } finally { app.endUndoGroup(); }
   (e) NIGDY nie wywołuj \`app.executeCommand(16)\` (Undo), \`app.executeCommand(app.findMenuCommandId("Undo"))\` ani \`app.executeCommand(...)\` z Redo w swoim kodzie - cofnęłoby to grupę wrappera, zostawiając AE w niespójnym stanie. System sam wykonuje Undo wrappera w przypadku błędu.
   (f) Domyślnie jeden krok orkiestracji = jedna grupa Undo w widoku użytkownika. Krótsze, atomowe kroki są LEPSZE - dają użytkownikowi bardziej granularne cofanie i czytelniejsze nazwy w historii.
   (g) Jeśli zauważysz w lastError komunikat o niezbalansowanych grupach Undo - to znak że Twój poprzedni kod albo nie zamknął grupy, albo otworzył nową bez zamknięcia. Napraw to natychmiast usuwając ręczne wywołania begin/end.
8. NIE dodawaj wywołań \`alert()\` ani \`confirm()\` jeśli skrypt się powiódł - zablokują UI After Effects. Komunikuj się przez "message" w odpowiedzi JSON.
8. DROBNIEJSZE KROKI (Micro-Orchestration): Zamiast pisać jeden potężny skrypt robiący wszystko naraz, podziel wykonanie na mniejsze, logiczne etapy używając pętli agentowej (\`is_task_complete: false\`). Rozbijanie zadania gwarantuje, że błędy będą cofać (UNDO) tylko ten mały konkretny fragment skryptu, pozostawiając poprawne poprzednie części na miejscu! Dostosuj liczbę kroków płynnie do analizy progresu zadania.
9. ŚCIĄGANIE WNIOSKÓW PAMIĘCI: Gdy skrypt "wybuchnie" i zwrócę Ci szczegóły błędu (lastError), ZAWSZE w następnej iteracji korzystaj z \`update_memory\`, by sformułować cenną regułę dla siebie na przyszłość, aby nigdy więcej nie zawiesić tak programu! Ucz się w locie i na zawsze!
10. KOD EXTENDSCRIPT W JSON (KRYTYCZNE): Zawsze zwracaj kod jako Tablicę Stringów (Array of strings) w kluczu "code". Nigdy nie używaj jednego wielkiego stringa zawierającego znaki nowej linii (Enter a nawet '\\n'), ponieważ wielokrotnie niszczy to parser JSON używany w silniku. Każdy wiersz Twojego kodu musi być osobnym elementem tablicy! Aby zminimalizować ryzyko wysypania się JSON, twój skrypt bezwzględnie MUSI być rozbity na bardzo krótkie operacje, zwracając is_task_complete: false i dobudowując resztę w następnym sygnale.
11. UPDATE_MEMORY (opcjonalne): Jeśli chcesz dodać regułę do pamięci długoterminowej, dodaj klucz "update_memory" do JSONa jako tablicę obiektów: [{"action": "add", "content": "Treść reguły"}]. Jeśli nie chcesz aktualizować pamięci w danym kroku, PO PROSTU POMIŃ ten klucz. NIE dodawaj go z pustą wartością.
14. SVG GENERATOR: w parallel_tasks uzyj klucza "svg": ["prompt na SVG generowany przez Gemini text model"]. Agent wygeneruje plik .svg i zaimportuje do AE.
15. IMAGE EDIT: w parallel_tasks uzyj klucza "edit_images": [{"prompt": "instrukcja edycji np. usun tlo, zmien kolor", "source": "last_image_0"}]. Agent edytuje istniejacy obraz AI i importuje wynik.
16. RENDER PREVIEW: uzyj klucza "render_preview": true (lub int np. 6), by przechwycic klatki z timeline do oceny animacji. Klatki pojawia sie w nastepnym vision context.
17. ZAKONCZENIE ZADANIA (KRYTYCZNE!!!): Gdy WSZYSTKIE kroki planu sa zakonczone: (a) ustaw "is_task_complete": true, (b) napisz krotkie podsumowanie w "message" (np. "Gotowe! Stworzylem kompozycje X z 3 warstwami i animacja kamery."). BEZ WYJATKOW! NIGDY nie wysylaj pustego kroku (bez code i parallel_tasks) z is_task_complete:false — system NATYCHMIAST zakonczy proces! JEDEN pusty krok = koniec. Typowe bledy: zapominasz o is_task_complete gdy plan mowi "Zakonczone" — SPRAWDZ TO przed wyslaniem odpowiedzi!
18. UNIKALNE NAZWY KOMPOZYCJI: Zanim stworzysz addComp("nazwa"), ZAWSZE wywolaj getUniqueCompName("nazwa") zeby uniknac duplikatow. Przyklad: var compName = getUniqueCompName("Winter Documentary"); var comp = app.project.items.addComp(compName, 1920, 1080, 1, 30, 30);
19. IMPORT vs KOMPOZYCJA: Pamietaj ze importAndAddToComp() NIE tworzy nowej kompozycji - tylko importuje footage do projektu (lub dodaje do aktywnej kompozycji). Tworz kompozycje WYLACZNIE w swoim kodzie ExtendScript, kiedy jestes gotowy na montaz.
20. MONTAZ TIMELINE (KRYTYCZNE): LEKTOR jest osia timeline. Algorytm montazu: (1) Podziel tekst lektora na segmenty tematyczne (np. zdanie/akapit o lesie, o ptakach, o rzece). (2) Oblicz czas kazdego segmentu PROPORCJONALNIE do liczby ZNAKOW (np. segment 120zn z 400zn calego tekstu = 30% czasu lektora). (3) Na kazdy segment moze przypadac WIECEJ niz 1 klip wideo! Jesli segment trwa 15s a klip ma 5s, uzyj 2-3 klipow lub time-stretching (layer.stretch). (4) Ukladaj klipy SEKWENCYJNIE: clip1.startTime=0, clip2.startTime=clip1.outPoint, itd. (5) Jesli klip jest za krotki - rozciagnij go (layer.stretch) lub powtorz z innym kadrem. (6) GENERUJ wystarczajaca liczbe klipow! Planuj 1 klip na kazde 5-7s narracji. Film 60s = minimum 8-12 klipow wideo. (7) Lektor na gorze, klipy pod nim, muzyka na dole (-15dB). NIGDY nie ukladaj losowo ani nie zostawiaj pustych luk!
21. MUZYKA POD LEKTORA: Warstwa muzyki audioLevels na -15dB. Lektor zawsze na wierzchu (nizszy index warstwy).
22. DLUGOSC FILMU: Dopasuj comp.duration do calkowitej dlugosci lektora/wideo na koncu montazu.
23. LEKTOR (TTS): Generuj JEDNEGO dlugiego lektora zamiast wielu krotkich skrawkow! Polacz caly tekst narracji w jeden prompt TTS. Wynik: jedna dluga sciezka audio, latwiejszy montaz, brak luk. System zmierzy dlugosc audio i automatycznie dopasuje dlugosc muzyki.
24. MUZYKA (LYRIA 3 PRO / ELEVEN MUSIC): Aktywny provider muzyki: ${this.musicProvider}. Dla Lyria 3 Pro - model automatycznie dopasowuje dlugosc utworu do timestampow w prompcie. Dla ElevenLabs Eleven Music - mozesz podac duration_seconds (10-300s), oraz force_instrumental (true/false). System dopasowuje dlugosc do TTS automatycznie. ELEVEN MUSIC obsluguje wokale - opisz w prompcie czy chcesz wokale (np. "with female vocals, English lyrics about freedom") czy tylko muzyke instrumentalna.
24b. ELEVEN MUSIC SKLADNIA (gdy ttsProvider=elevenlabs lub musicProvider=elevenlabs): parallel_tasks.music moze byc albo stringiem (prosty prompt) albo obiektem: {"prompt": "epic orchestral cinematic", "duration_seconds": 60, "force_instrumental": true, "composition_plan": null}. Dla utworow z wokalami zostaw force_instrumental=false i opisz lirykę.
24c. SFX (ELEVENLABS TEXT-TO-SOUND-EFFECTS): w parallel_tasks uzyj klucza "sfx" do generowania krotkich efektow dzwiekowych (0.5-22 sek). Skladnia: parallel_tasks.sfx: [{"prompt": "cinematic whoosh transition", "duration_seconds": 2, "prompt_influence": 0.4, "loop": false}]. KLUCZOWE: prompt_influence 0-1 (default 0.3) — wyzsze wartosci = bardziej literalna interpretacja prompta, nizsze = wiecej kreatywnosci modelu. Loop=true tworzy zapętlony efekt (np. ambient, deszcz). Idealne dla: whooshes, impacts, ambient, riser, drone, foley, UI sounds, transition effects, glitch sounds, magic spells, atmosfera (deszcz, las, miasto). NIE uzywaj SFX do dlugich utworow muzycznych - od tego jest "music".
25. PROMPTY OBRAZOW I WIDEO (KRYTYCZNE): Kazdy prompt do obrazu MUSI miec minimum 500 znakow. Opisuj dokladnie CO jest w danym kadrze - opowiedz scene jak rezyser filmowy. Zawieraj elementy techniczne i artystyczne ALE za kazdym razem INNE, unikalne, nieszablonowe. NIE POWTARZAJ tych samych schematow! Mozesz uzyc (jako INSPIRACJE, nie nakazy): typ obiektywu, styl oswietlenia, glebokosc ostrosci, kompozycje, kontrast, palety barw, nastroj, tekstury, ruch w kadrze, perspektywe, typ aparatu/kamery, aberracje, ziarno filmu - ale MIESZAJ je tworczo, zaskakuj, lamuj konwencje. Czasem zrob cos surowego na smartfona, innym razem perfekcyjne na medium format. Wazne: prompt musi spójnie opisywac JEDEN KONKRETNY kadr - nie ogolniki. Nigdy nie rob dwoch identycznych promptow
26. MANIFEST ASSETOW: Po kazdym kroku generowania otrzymasz manifest z lista plikow (nazwa, typ, prompt, dlugosc). UZYWAJ tych nazw w kodzie ExtendScript! Szukaj plikow w projekcie po NAZWIE z manifestu, nie zgaduj.
27. WERSJONOWANIE (KRYTYCZNE): Gdy edytujesz obraz (edit_images), NOWA wersja ZASTEPUJE stara. W timeline i animacjach ZAWSZE uzywaj NAJNOWSZEJ wersji. Manifest oznacza je jako "supersedes". Jesli uzytkownik kazal poprawic zdjecie, to w kompozycji uzyj POPRAWIONEGO pliku, NIE oryginalu!
28. SZUKANIE ASSETOW W PROJEKCIE: Zamiast zglaszac bledy "nie znalazlem pliku", przeszukaj projekt petla: for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i).name.indexOf("fragment_nazwy")!==-1){...}} Pliki generowane maja odpowiednie prefiksy: aisist_img_, aisist_vid_, aisist_tts_, aisist_music_, aisist_edit_, aisist_svg_.
29. VIDEO GROK + OBRAZY (KRYTYCZNE): Gdy generujesz obrazy i wideo w tym samym kroku, KAZDY element video_grok MUSI miec "source": "last_image_N" wskazujacy na odpowiedni obraz! System automatycznie czeka na zakonczenie generowania obrazow, odczytuje wygenerowany plik i wysyla go do Groka jako klatke bazowa (image-to-video). BEZ "source" Grok generuje wideo od zera, ignorujac Twoje obrazy! Przyklad: {"prompt":"slow pan across snowy forest","source":"last_image_0","duration":5,"aspect_ratio":"16:9"}
30. KOLEJNOSC OBRAZOW: last_image_0 = pierwszy obraz z tablicy images, last_image_1 = drugi, itd. Jesli images:["las","ptak","rzeka","sikorka"] i video_grok ma 4 elementy, to source powinno byc odpowiednio last_image_0, last_image_1, last_image_2, last_image_3.
31. KOLEJNOSC PRODUKCJI (KRYTYCZNE): Planuj kroki w tej kolejnosci: KROK 1: Wygeneruj lektora (TTS) - JEDNEGO dlugiego. Muzyka moze byc w tym samym kroku (system automatycznie dopasuje dlugosc do lektora). KROK 2: Wygeneruj obrazy dopasowane do SEGMENTOW narracji (kazdy obraz ilustruje konkretny fragment tekstu lektora). KROK 3: Ozyw obrazy do wideo (Grok, z source: last_image_N). KROK 4: Zmontuj timeline w AE (lektor na gorze, klipy proporcjonalnie pod nim, muzyka na dole). NIE generuj obrazow w tym samym kroku co lektora - najpierw musisz ZNAC tresc narracji zeby wiedziec jakie kadry tworzyc!
32. PROMPTY VIDEO_GROK (KRYTYCZNE): Prompt do wideo NIE POWTARZA opisu sceny z obrazu! Obraz juz DEFINIUJE scene wizualna. Prompt do wideo opisuje WYLACZNIE: ruch kamery (slow pan left, dolly forward, gentle zoom in, static shot), dynamike (subtle motion, dramatic sweep), efekty atmosferyczne (snow falling, fog drifting, wind in trees). Przyklad DOBRY: "Slow cinematic dolly forward through the forest, subtle snow particles falling, gentle camera shake". Przyklad ZLY: "A beautiful snowy forest with pine trees and a river" (to juz jest na obrazie!).
33. PYTHON ENVIRONMENTS: Masz dostep do srodowisk Python! W parallel_tasks uzyj klucza "python": [{"env":"nazwa_env","packages":["numpy","Pillow"],"git_repos":["https://github.com/user/repo"],"script":"import numpy; print(numpy.__version__)","command":"python -c 'test'"}]. System automatycznie stworzy venv, zainstaluje pakiety, sklonuje repo i uruchomi skrypt. Srodowiska sa PERSYSTENTNE - raz zainstalowane pakiety sa dostepne w kolejnych krokach. Uzywaj tego do: zaawansowanego przetwarzania obrazow, generowania danych, uruchamiania narzedzi AI/ML, automatyzacji z bibliotekami Python.
34. WHISPERX TRANSKRYPCJA (DEDYKOWANY TOOL): Do transkrypcji audio na poziomie SLOW uzyj klucza "whisperx" w parallel_tasks: "whisperx": [{"source": "last_audio"}] lub "whisperx": [{"source": "D:/sciezka/do/pliku.wav"}]. System uruchomi Whisper w dedykowanym srodowisku Python, zwroci JSON ze slowami i timestampami (start/end na poziomie slowa). Wynik pojawi sie w kontekscie agenta jako JSON. NIE uzywaj transcribe_audio z ElevenLabs do tego celu - to jest inne narzedzie!
35. PYTHON AUTONOMIA (KRYTYCZNE): Masz pelna autonomie w tworzeniu skryptow Python! (a) Napisz skrypt, (b) Uruchom, (c) Przeczytaj stdout/stderr, (d) Jesli bledy - POPRAW i uruchom ponownie. Mozesz iterowac wielokrotnie. Szukaj odpowiednich bibliotek (pip) do kazdego zadania. Klonuj repozytoria GitHub jesli potrzeba. 
36. SKILLE PYTHON: Gdy stworzysz DZIALAJACY skrypt, ZAPISZ go jako skill dodajac do parallel_tasks.python: "save_as_skill": {"name":"whisperx_transcribe","description":"Word-level transkrypcja audio"}. Skill pojawi sie w Twojej palecie i mozesz go uzyc ponownie. Na poczatku kazdego zadania sprawdz kontekst TWOJE SKILLE - moze juz masz gotowe narzedzie!
37. PYTHON PELNE SCIEZKI (KRYTYCZNE): W skryptach Python ZAWSZE uzywaj PELNYCH sciezek do plikow! Manifest assetow podaje pelne sciezki - uzyj ich. NIE uzywaj samych nazw plikow bo skrypt Python dziala w katalogu venv, nie w katalogu projektu! Przyklad: img = Image.open(r"D:/full/path/to/aisist_img_forest_174829.png") a NIE: img = Image.open("aisist_img_forest_174829.png").
38. LOKALNE NARZEDZIA I SERWISY: Jesli potrzebujesz lokalnego narzedzia (ComfyUI, Stable Diffusion, serwer API, baza danych itp.) — UZYJ PYTHONA by je odkryc, uruchomic i zintegrowac. Szukaj na dysku, sprawdzaj porty, startuj procesy. ZAPISZ konfiguracje do LTM (replace_category: "local_tools") i gotowy skrypt jako skill. Nigdy nie zakladaj ze cos jest zainstalowane — SPRAWDZ NAJPIERW. Pytaj uzytkownika jesli nie mozesz znalezc.
39. PROCESY W TLE: Mozesz uruchamiac aplikacje/serwisy w tle! W parallel_tasks.python dodaj: "background": true, "background_name": "comfyui", "background_cmd": "cd A:\ComfyUI && python main.py", "ready_keyword": "listening on". System: (a) uruchomi proces detached, (b) bedzie watchowal stdout na ready_keyword, (c) zwroci status. Jesli proces o tej nazwie juz dziala - NIE URUCHAMIAJ PONOWNIE (dedup). Status procesow w tle widzisz w kontekscie === PROCESY W TLE ===. Uzywaj tego do: uruchamiania ComfyUI, serwerow API, baz danych itp.
40. DOPYTUJ GDY NIE JESTES PEWIEN: Jesli nie masz pewnosci co do: lokalizacji plikow, preferencji uzytkownika, parametrow generowania, stylu, wyboru narzedzia — ZAPYTAJ uzytkownika uzywajac "questions_for_user". Lepiej zapytac niz zgadywac i tracic czas. Szczegolnie dopytuj na poczatku zlozonych zadan (o styl, rozdzielczosc, dlugosc, nastroj). Ale ROWNOWAŻ to — nie pytaj o oczywistosci. Jesli masz 80%+ pewnosci, dzialaj.
41. SAMODZIELNE ZALACZANIE PLIKOW (attach_files): Mozesz samodzielnie dolaczac pliki z dysku do swojego kontekstu! W odpowiedzi dodaj "attach_files": [{"path": "D:/pelna/sciezka/do/pliku.png", "label": "Opis"}]. Obslugiwane typy: obrazy (png/jpg/webp), audio (mp3/wav), wideo (mp4/webm), tekst (txt/json/srt/jsx/py/csv). Pliki binarne pojawia sie jako Vision w nastepnej iteracji. Pliki tekstowe zostana wstrzykniete jako tekst. UZYWAJ TEGO do: analizy assetow projektu, czytania plikow konfiguracyjnych, sprawdzania renderow, inspekcji skryptow. Sciezki musza byc PELNE!
42. OBRAZY REFERENCYJNE W GENEROWANIU: Gdy user zalaczy zdjecia (attach) lub wczesniej wygenerowal obrazy — SA ONE AUTOMATYCZNIE przekazywane do Gemini Image jako referencja. Gemini widzi je i moze sie na nich wzorowac. Uzywaj tego do: character sheets, style transfer, edycji istniejacych obrazow. NIE GENERUJ W PETLI tego samego — jesli obraz nie spelnia oczekiwan, ZAPYTAJ usera co zmienic zamiast generowac 10 razy to samo!
43. IMPORT PLIKOW DO AE (KRYTYCZNE): Do importu plikow do projektu uzyj PROSTEGO kodu ExtendScript: var f = new ImportOptions(File("D:/sciezka/do/pliku.json")); var item = app.project.importFile(f); NIGDY nie twórz zlozonych mostow Python→plik→AE! Jesli potrzebujesz sciezki do folderu footage: var folder = app.project.file ? app.project.file.parent.fsName : "~/Desktop"; Sciezka do wygenerowanego obrazu jest w manifescie assetow ktory dostajesz po parallel_tasks. Uzyj jej bezposrednio w ImportOptions.


${this.getBackgroundProcessSummary()}

=== TWOJE ZAPISANE SKILLE PYTHON ===
${this.getSkillsSummary()}
=== KONIEC SKILLI ===
`;
    }

    // --- LTM Formatting (grouped by category, newest first) ---
    formatLTMForPrompt() {
        if (!this.longTermMemory || this.longTermMemory.length === 0) {
            return '(Pusta pamiec - brak regul)';
        }
        // Group by category
        const groups = {};
        this.longTermMemory.forEach(m => {
            const cat = m.category || 'general';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(m);
        });
        // Sort each group by timestamp (newest first), then format
        let result = '';
        Object.keys(groups).sort().forEach(cat => {
            const entries = groups[cat].sort((a, b) => {
                const ta = a.timestamp || '1970';
                const tb = b.timestamp || '1970';
                return tb.localeCompare(ta); // newest first
            });
            result += '\n[KATEGORIA: ' + cat.toUpperCase() + '] (' + entries.length + ' wpisow)\n';
            entries.forEach(m => {
                const ts = m.timestamp ? m.timestamp.substring(0, 10) : '?';
                const ver = m.version && m.version > 1 ? ' (v' + m.version + ')' : '';
                result += '  [ID:' + m.id + ' | ' + ts + ver + '] ' + m.content + '\n';
            });
        });
        return result;
    }

    // --- Background Process Manager ---
    getBackgroundProcessSummary() {
        const names = Object.keys(this.backgroundProcesses);
        if (names.length === 0) return '';
        let result = '\n=== PROCESY W TLE ===\n';
        names.forEach(name => {
            const p = this.backgroundProcesses[name];
            const uptime = Math.round((Date.now() - p.startedAt) / 1000);
            result += '[' + name + '] PID:' + p.pid + ' | Status:' + p.status + ' | Ready:' + (p.isReady ? 'TAK' : 'NIE') + ' | Uptime:' + uptime + 's\n';
            if (p.lastOutput) result += '  Last: ' + p.lastOutput.substring(0, 150) + '\n';
        });
        result += '=== KONIEC PROCESOW ===\n';
        return result;
    }
    
    isProcessRunning(name) {
        const p = this.backgroundProcesses[name];
        if (!p) return false;
        try {
            process.kill(p.pid, 0); // Signal 0 = just check if exists
            return true;
        } catch(e) {
            // Process is dead — clean up
            p.status = 'dead';
            return false;
        }
    }
    
    killBackgroundProcess(name) {
        const p = this.backgroundProcesses[name];
        if (!p) return false;
        try {
            process.kill(p.pid);
            delete this.backgroundProcesses[name];
            return true;
        } catch(e) {
            delete this.backgroundProcesses[name];
            return false;
        }
    }

    // --- Python Skills Registry ---
    getSkillsRegistryPath() {
        const path = require('path');
        return path.join(this.getPythonSandboxRoot(), 'skills_registry.json');
    }
    
    loadSkillsRegistry() {
        const fsNode = require('fs');
        const regPath = this.getSkillsRegistryPath();
        if (fsNode.existsSync(regPath)) {
            try { return JSON.parse(fsNode.readFileSync(regPath, 'utf8')); } catch(e) { return { skills: [] }; }
        }
        return { skills: [] };
    }
    
    savePythonSkill(skillDef) {
        const fsNode = require('fs');
        const path = require('path');
        const regPath = this.getSkillsRegistryPath();
        const registry = this.loadSkillsRegistry();
        const existingIdx = registry.skills.findIndex(s => s.name === skillDef.name);
        const entry = {
            name: skillDef.name,
            description: skillDef.description || '',
            env: skillDef.env || 'default',
            packages: skillDef.packages || [],
            scriptPath: skillDef.scriptPath || null,
            scriptContent: skillDef.scriptContent || null,
            createdAt: existingIdx >= 0 ? registry.skills[existingIdx].createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) registry.skills[existingIdx] = entry;
        else registry.skills.push(entry);
        const dir = path.dirname(regPath);
        if (!fsNode.existsSync(dir)) fsNode.mkdirSync(dir, { recursive: true });
        fsNode.writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf8');
        return entry;
    }
    
    getSkillsSummary() {
        const registry = this.loadSkillsRegistry();
        if (registry.skills.length === 0) return 'Brak zapisanych skilli Python.';
        return registry.skills.map(function(s, i) { return (i+1) + '. ' + s.name + ' (' + s.env + ') - ' + s.description + ' [' + (s.packages || []).join(', ') + ']'; }).join('\n');
    }

    // New signature accepts a full config object — keeps backward-compatible positional fallback
    setCredentials(cfg) {
        // Legacy positional-args bridge (only triggers if first arg is a string)
        if (typeof cfg === 'string') {
            const a = Array.prototype.slice.call(arguments);
            cfg = {
                apiKey: a[0], replicateApiKey: a[1], elevenlabsApiKey: a[2],
                geminiModel: a[3], geminiImageModel: a[4], ttsModel: a[5],
                ttsVoice: a[6], uiLang: a[7], projLang: a[8], useGrounding: a[9]
            };
        }
        cfg = cfg || {};
        const assign = (key, target, storeKey) => {
            if (cfg[key] !== undefined) {
                this[target] = cfg[key];
                diskStorage.setItem(storeKey, cfg[key]);
            }
        };

        assign('apiKey', 'apiKey', 'aisist_api_key');
        assign('openrouterApiKey', 'openrouterApiKey', 'hexart_openrouter_key');
        assign('replicateApiKey', 'replicateApiKey', 'aisist_replicate_key');
        assign('elevenlabsApiKey', 'elevenlabsApiKey', 'aisist_elevenlabs_key');

        assign('llmProvider', 'llmProvider', 'hexart_llm_provider');
        assign('imgProvider', 'imgProvider', 'hexart_img_provider');
        assign('geminiModel', 'geminiModel', 'hexart_gemini_model');
        assign('openrouterLLMModel', 'openrouterLLMModel', 'hexart_openrouter_llm_model');
        assign('lmstudioLLMModel', 'lmstudioLLMModel', 'hexart_lmstudio_llm_model');
        assign('lmstudioBaseUrl', 'lmstudioBaseUrl', 'hexart_lmstudio_url');
        assign('geminiImageModel', 'geminiImageModel', 'hexart_gemini_img_model');
        assign('openrouterImageModel', 'openrouterImageModel', 'hexart_openrouter_img_model');

        assign('ttsModel', 'ttsModel', 'aisist_tts_model');
        assign('ttsVoice', 'ttsVoice', 'aisist_tts_voice');
        assign('uiLang', 'uiLanguage', 'aisist_ui_lang');
        assign('projLang', 'projectLanguage', 'aisist_proj_lang');

        if (cfg.useGrounding !== undefined) {
            this.useGrounding = !!cfg.useGrounding;
            diskStorage.setItem('aisist_grounding', this.useGrounding ? 'true' : 'false');
        }

        assign('pythonSandboxPath', 'pythonSandboxPath', 'hexart_sandbox_path');
        assign('toolsCachePath', 'toolsCachePath', 'hexart_tools_cache_path');

        // ---- TTS/STT provider + ElevenLabs config ---------------------
        assign('ttsProvider', 'ttsProvider', 'hexart_tts_provider');
        assign('sttProvider', 'sttProvider', 'hexart_stt_provider');
        assign('elevenlabsModel', 'elevenlabsModel', 'hexart_elevenlabs_model');
        assign('elevenlabsSttModel', 'elevenlabsSttModel', 'hexart_elevenlabs_stt_model');
        assign('elevenlabsDefaultVoice', 'elevenlabsDefaultVoice', 'hexart_elevenlabs_default_voice');
        assign('elevenlabsMaleVoice', 'elevenlabsMaleVoice', 'hexart_elevenlabs_male_voice');
        assign('elevenlabsFemaleVoice', 'elevenlabsFemaleVoice', 'hexart_elevenlabs_female_voice');
        assign('elevenlabsOutputFormat', 'elevenlabsOutputFormat', 'hexart_elevenlabs_output_format');
        assign('musicProvider', 'musicProvider', 'hexart_music_provider');
        if (cfg.elevenlabsSfxPromptInfluence !== undefined) {
            this.elevenlabsSfxPromptInfluence = parseFloat(cfg.elevenlabsSfxPromptInfluence);
            diskStorage.setItem('hexart_elevenlabs_sfx_influence', String(this.elevenlabsSfxPromptInfluence));
        }
        if (cfg.elevenlabsSfxDefaultDuration !== undefined) {
            this.elevenlabsSfxDefaultDuration = parseFloat(cfg.elevenlabsSfxDefaultDuration);
            diskStorage.setItem('hexart_elevenlabs_sfx_default_duration', String(this.elevenlabsSfxDefaultDuration));
        }
        if (cfg.elevenlabsMusicForceInstrumental !== undefined) {
            this.elevenlabsMusicForceInstrumental = !!cfg.elevenlabsMusicForceInstrumental;
            diskStorage.setItem('hexart_elevenlabs_music_force_instr', this.elevenlabsMusicForceInstrumental ? 'true' : 'false');
        }
        if (cfg.elevenlabsUseGeneralDefault !== undefined) {
            this.elevenlabsUseGeneralDefault = !!cfg.elevenlabsUseGeneralDefault;
            diskStorage.setItem('hexart_elevenlabs_use_general_default', this.elevenlabsUseGeneralDefault ? 'true' : 'false');
        }
        if (cfg.elevenlabsVoiceSettings && typeof cfg.elevenlabsVoiceSettings === 'object') {
            this.elevenlabsVoiceSettings = Object.assign({}, this.elevenlabsVoiceSettings, cfg.elevenlabsVoiceSettings);
            diskStorage.setItem('hexart_elevenlabs_voice_settings', JSON.stringify(this.elevenlabsVoiceSettings));
        }
        // ---- Feature flags --------------------------------------------
        if (cfg.featureFlags && typeof cfg.featureFlags === 'object') {
            this.featureFlags = Object.assign({}, this.featureFlags, cfg.featureFlags);
            diskStorage.setItem('hexart_feature_flags', JSON.stringify(this.featureFlags));
        }

        // Update derived/effective models for legacy code paths
        this.baseModel = this.getActiveLLMModel();
        this.imageModel = this.getActiveImageModel();
        // Refresh ElevenLabs client cache so new key takes effect
        if (this._elevenLabsClient) this._elevenLabsClient.setApiKey(this.elevenlabsApiKey);
    }

    // Resolve which voice to use given an optional gender hint (m/f or "male"/"female")
    resolveElevenLabsVoice(genderHint) {
        if (this.elevenlabsUseGeneralDefault && this.elevenlabsDefaultVoice) {
            return this.elevenlabsDefaultVoice;
        }
        const g = (genderHint || '').toString().toLowerCase();
        if ((g === 'm' || g.startsWith('male') || g === 'kobieta_no' /* unlikely */) && this.elevenlabsMaleVoice) {
            return this.elevenlabsMaleVoice;
        }
        if ((g === 'f' || g.startsWith('female') || g.startsWith('w') /* woman */) && this.elevenlabsFemaleVoice) {
            return this.elevenlabsFemaleVoice;
        }
        // Final fallbacks
        return this.elevenlabsDefaultVoice
            || this.elevenlabsMaleVoice
            || this.elevenlabsFemaleVoice
            || '';
    }

    async getAEContext() {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            csInterface.evalScript('getAEContext()', (res) => {
                try {
                    resolve(JSON.parse(res));
                } catch(e) {
                    console.error("Parse error AE Context:", res);
                    resolve({ error: "Błąd ExtendScript: " + res, hasActiveComp: false });
                }
            });
        });
    }

    async getDeepAEContext() {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            csInterface.evalScript('getDeepAEContext()', (res) => {
                try {
                    resolve(JSON.parse(res));
                } catch(e) {
                    console.error("Parse error Deep AE Context:", res);
                    resolve({ error: "Deep scan failed: " + res });
                }
            });
        });
    }

    // --- Render Preview (Multi-frame capture for vision) ---
    async captureRenderPreview(numFrames) {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            const n = numFrames || 4;
            csInterface.evalScript('getMultiFramePreview(' + n + ')', (res) => {
                try {
                    const result = JSON.parse(res);
                    if (result.error) {
                        resolve({ error: result.error, frames: [] });
                        return;
                    }
                    // Read each frame PNG as base64
                    const fs = require('fs');
                    const frames = [];
                    for (const frame of result.frames) {
                        try {
                            const b64 = fs.readFileSync(frame.path, 'base64');
                            frames.push({ time: frame.time, data: b64, mimeType: 'image/png' });
                            // Clean up temp file
                            try { fs.unlinkSync(frame.path); } catch(e) {}
                        } catch(readErr) {
                            console.error('Failed to read preview frame:', readErr);
                        }
                    }
                    resolve({ success: true, frames: frames });
                } catch(e) {
                    resolve({ error: 'Parse error: ' + e.toString(), frames: [] });
                }
            });
        });
    }

    async getProjectFootageDir() {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            csInterface.evalScript(`(function(){ 
                try { 
                    if (app.project.file) { 
                        return app.project.file.parent.fsName; 
                    } 
                } catch(e) {} 
                return ""; 
            })()`, (res) => {
                if (res && res !== "undefined" && res !== "") {
                    const fs = require('fs');
                    const path = require('path');
                    const footagePath = path.join(res, "footage");
                    if (!fs.existsSync(footagePath)) {
                        try { fs.mkdirSync(footagePath, { recursive: true }); } catch(e) {}
                    }
                    resolve(footagePath);
                } else {
                    const os = require('os');
                    resolve(os.tmpdir());
                }
            });
        });
    }
    
    async getAESnapshot() {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            csInterface.evalScript('getAESnapshot()', (res) => {
                if (!res || res.startsWith("ERROR") || res === "NO_COMP") {
                    resolve(null);
                } else {
                    if (typeof require !== 'undefined') {
                        const fs = require('fs');
                        try {
                            const base64 = fs.readFileSync(res, 'base64');
                            if (base64.length < 500) {
                                if (typeof addLog !== 'undefined') addLog(`Zrzut ekranu jest pusty lub uszkodzony (${base64.length} bajtów), pomijam wysyłanie jako Vision.`, 'warning');
                                resolve(null);
                                return;
                            }
                            if (typeof addLog !== 'undefined') { // Check if addLog is defined
                                addLog(`Zrzut ekranu przygotowany (${base64.length} bajtów).`, 'info');
                            }
                            resolve({
                                mimeType: "image/png",
                                data: base64
                            });
                        } catch(e) {
                            console.error("Failed to read snapshot", e);
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                }
            });
        });
    }

    async runExtendScript(code) {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            // Primary transport: write code to a temp file and tell ExtendScript to read it.
            // This avoids CEP evalScript size limits (~16-64KB) and base64 polyfill bugs.
            const fsNode = require('fs');
            const pathNode = require('path');
            const osNode = require('os');
            const tmpPath = pathNode.join(osNode.tmpdir(),
                'hexart_runscript_' + Date.now() + '_' + Math.floor(Math.random() * 99999) + '.jsx');

            const fallbackB64 = () => {
                // Last-resort fallback: small base64 inline (only for very short scripts).
                try {
                    const b64 = Buffer.from(code, 'utf8').toString('base64');
                    csInterface.evalScript('runAgentCodeB64("' + b64 + '")', (res) => {
                        if (!res) { resolve({ success: false, error: 'Empty ExtendScript response.' }); return; }
                        try { resolve(JSON.parse(res)); }
                        catch (e) {
                            console.error('Parse error runExtendScript (fallback):', res);
                            resolve({ success: false, error: 'Bad ExtendScript JSON: ' + String(res).substring(0, 500) });
                        }
                    });
                } catch (e) {
                    resolve({ success: false, error: 'Fallback transport failed: ' + e.message });
                }
            };

            try {
                fsNode.writeFileSync(tmpPath, code, 'utf8');
            } catch (writeErr) {
                console.error('Cannot write tmp script, falling back to base64:', writeErr);
                fallbackB64();
                return;
            }
            const safePath = tmpPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            csInterface.evalScript('runAgentCodeFromFile("' + safePath + '")', (res) => {
                if (!res) {
                    // ExtendScript bridge returned empty — try fallback.
                    try { fsNode.unlinkSync(tmpPath); } catch(_) {}
                    fallbackB64();
                    return;
                }
                try { resolve(JSON.parse(res)); }
                catch (e) {
                    console.error('Parse error runExtendScript:', res);
                    // Best-effort cleanup (ExtendScript removes the file itself but if read failed, do it here)
                    try { if (fsNode.existsSync(tmpPath)) fsNode.unlinkSync(tmpPath); } catch(_) {}
                    resolve({ success: false, error: 'Bad ExtendScript JSON: ' + String(res).substring(0, 500) });
                }
            });
        });
    }

    // --- Code Validator (Pre-flight Check) ---
    // Strips comments + string literals so checks don't fire on docs/text.
    validateCode(codeString) {
        const warnings = [];
        const errors = [];

        // Strip JS-style comments and string literals to avoid false positives.
        const stripped = (function strip(src) {
            let out = '';
            let i = 0;
            const len = src.length;
            while (i < len) {
                const c = src[i];
                const c2 = src[i + 1];
                if (c === '/' && c2 === '/') {
                    while (i < len && src[i] !== '\n') i++;
                } else if (c === '/' && c2 === '*') {
                    i += 2;
                    while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
                    i += 2;
                } else if (c === '"' || c === "'") {
                    const q = c; out += ' '; i++;
                    while (i < len) {
                        if (src[i] === '\\' && i + 1 < len) { i += 2; continue; }
                        if (src[i] === q) { i++; break; }
                        i++;
                    }
                    out += ' ';
                } else {
                    out += c; i++;
                }
            }
            return out;
        })(codeString);

        if (/\balert\s*\(/.test(stripped)) errors.push('Niedozwolone: alert() zablokuje UI After Effects.');
        if (/\bconfirm\s*\(/.test(stripped)) errors.push('Niedozwolone: confirm() dialog blokuje UI AE.');
        if (/while\s*\(\s*(?:true|1)\s*\)/.test(stripped)) errors.push('Niebezpieczne: while(true) moze zawiesic AE.');
        if (/\bdebugger\b/.test(stripped)) warnings.push('debugger w skrypcie - usun przed wysylka.');

        // UndoGroup discipline: count begin/end pairs and flag imbalances + raw "rollback" calls.
        const beginGroups = (stripped.match(/app\.beginUndoGroup\s*\(/g) || []).length;
        const endGroups = (stripped.match(/app\.endUndoGroup\s*\(/g) || []).length;
        if (beginGroups !== endGroups) {
            errors.push('UndoGroup niezbalansowany (begin=' + beginGroups + ', end=' + endGroups + '). Wrapper juz otwiera grupe - usun wlasne begin/endUndoGroup LUB upewnij sie ze sa w parze (w try/finally).');
        } else if (beginGroups > 0) {
            warnings.push('UndoGroup: wrapper juz otwiera grupe automatycznie - usun zbedne app.beginUndoGroup() ze swojego kodu chyba ze celowo dzielisz krok na pod-operacje.');
        }
        if (/app\.executeCommand\s*\(\s*(?:16|app\.findMenuCommandId\s*\(\s*["'](Undo|Redo)["']\s*\))/.test(stripped)) {
            errors.push('Niedozwolone: app.executeCommand(Undo/Redo) - cofnie grupe wrappera i zniszczy spojnosc historii. System sam wykonuje Undo przy bledzie.');
        }

        if (/app\.project\.file\./.test(stripped) &&
            !/app\.project\.file\s*(?:!==?\s*null|&&)/.test(stripped)) {
            warnings.push('app.project.file moze byc null. Dodaj sprawdzenie: if(app.project.file) {...}');
        }

        const badMethods = [
            { pattern: /\.moveToBack\s*\(/, fix: 'Uzyj layer.moveTo(comp.numLayers) zamiast moveToBack()' },
            { pattern: /\.moveToFront\s*\(/, fix: 'Uzyj layer.moveTo(1) zamiast moveToFront()' },
            { pattern: /\.setPosition\s*\(/, fix: 'Uzyj layer.position.setValue([x,y]) zamiast setPosition()' },
            { pattern: /\.setScale\s*\(/, fix: 'Uzyj layer.scale.setValue([x,y]) zamiast setScale()' },
            { pattern: /\.setOpacity\s*\(/, fix: 'Uzyj layer.opacity.setValue(x) zamiast setOpacity()' },
            { pattern: /\.setRotation\s*\(/, fix: 'Uzyj layer.rotation.setValue(x) zamiast setRotation()' },
            { pattern: /\.addKeyFrame\s*\(/, fix: 'Uzyj property.setValueAtTime(time, val) zamiast addKeyFrame()' },
            { pattern: /\.removeAll\s*\(/, fix: 'removeAll() nie istnieje. Usuwaj elementy petla od konca.' },
            { pattern: /\.forEach\s*\(/, fix: 'forEach() nie istnieje w ExtendScript! Uzyj petli for(var i=...).' },
            { pattern: /\.includes\s*\(/, fix: 'includes() nie istnieje w ExtendScript! Uzyj indexOf() !== -1.' },
            { pattern: /JSON\.parse\s*\(/, fix: 'JSON.parse() nie istnieje w ExtendScript! Uzyj eval("(" + str + ")").' },
            { pattern: /JSON\.stringify\s*\(/, fix: 'JSON.stringify() nie istnieje w ExtendScript! Napisz wlasna serializacje.' },
            { pattern: /\bconst\s+/, fix: 'const nie istnieje w ExtendScript! Uzyj var.' },
            { pattern: /\blet\s+/, fix: 'let nie istnieje w ExtendScript! Uzyj var.' }
        ];
        const softBadMethods = [
            { pattern: /\b[A-Za-z_$][\w$]*\s*\.map\s*\(/, fix: 'Array.map() nie istnieje w ExtendScript! Uzyj petli for.' },
            { pattern: /\b[A-Za-z_$][\w$]*\s*\.filter\s*\(/, fix: 'Array.filter() nie istnieje w ExtendScript! Uzyj petli for.' }
        ];
        badMethods.forEach(bm => { if (bm.pattern.test(stripped)) errors.push(bm.fix); });
        softBadMethods.forEach(bm => { if (bm.pattern.test(stripped)) warnings.push(bm.fix); });

        let parens = 0, braces = 0, brackets = 0;
        for (let i = 0; i < stripped.length; i++) {
            const c = stripped[i];
            if (c === '(') parens++; else if (c === ')') parens--;
            else if (c === '{') braces++; else if (c === '}') braces--;
            else if (c === '[') brackets++; else if (c === ']') brackets--;
        }
        if (parens !== 0) errors.push('Niedopasowane nawiasy (): ' + parens);
        if (braces !== 0) errors.push('Niedopasowane klamry {}: ' + braces);
        if (brackets !== 0) errors.push('Niedopasowane []: ' + brackets);

        if (codeString.length > 8000) warnings.push('Skrypt bardzo dlugi (' + codeString.length + ' znakow).');

        // Destructive-op surveillance: flag patterns that remove user content.
        // We do NOT block these outright (the agent may have a legitimate reason), but we
        // collect them so the main loop can ask user for permission BEFORE execution.
        const destructiveOps = [];
        const destructivePatterns = [
            { rx: /app\.project\.item\s*\(\s*([^)]+)\)\s*\.remove\s*\(/g, op: 'delete_project_item' },
            { rx: /([A-Za-z_$][\w$]*Layer\w*|layer)\s*\.\s*remove\s*\(\s*\)/g, op: 'delete_layer' },
            { rx: /\.removeAtTime\s*\(/g, op: 'remove_keyframe' },
            { rx: /\bnew\s+File\s*\(([^)]+)\)\s*[;.\s]*\.\s*remove\s*\(/g, op: 'file_remove' },
            { rx: /\bFile\.remove\s*\(/g, op: 'file_remove' }
        ];
        destructivePatterns.forEach(p => {
            let m;
            while ((m = p.rx.exec(stripped)) !== null) {
                destructiveOps.push({ op: p.op, snippet: m[0].substring(0, 80), target: (m[1] || '').trim() });
            }
        });

        return { valid: errors.length === 0, errors, warnings, destructiveOps };
    }

    // --- Expression Presets Library ---
    get expressionPresets() {
        return {
            easeInOut: 'ease(time, inPoint, outPoint, startVal, endVal)',
            typewriter: 'substr(0, Math.floor((time - inPoint) * charsPerSec))',
            wiggleSmooth: 'seedRandom(index, true); wiggle(freq, amp)',
            countUp: 'Math.floor(linear(time, inPoint, outPoint, startNum, endNum))',
            springBounce: 'n=0;if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time)n--}if(n>0){t=time-key(n).time;amp=velocityAtTime(key(n).time-0.001);freq=3;decay=5;value+amp*(Math.sin(t*freq*Math.PI*2)/Math.exp(decay*t))}else{value}',
            fadeInOut: 'fadeIn=0.5;fadeOut=0.5;Math.min(linear(time,inPoint,inPoint+fadeIn,0,100),linear(time,outPoint-fadeOut,outPoint,100,0))',
            loopBounce: 'loopOut("pingpong")',
            scaleOnBeat: 'amp=15;freq=2;decay=3;n=0;if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time)n--};if(n>0){t=time-key(n).time;s=amp*Math.sin(t*freq*2*Math.PI)/Math.exp(decay*t);value+[s,s]}else{value}',
            parallaxScroll: 'value+[thisComp.layer("Null").effect("Slider Control")("Slider")*index*0.1,0]',
            textRevealMask: 'startTime=inPoint;revealDur=1;progress=clamp((time-startTime)/revealDur,0,1);ease(progress,0,1)*100',
            colorPulse: 'freq=1;amp=0.3;base=value;[base[0]+Math.sin(time*freq*Math.PI*2)*amp,base[1],base[2],base[3]]'
        };
    }

    async generateImageBase64(prompt, referenceImages) {
        if (!this.isFeatureEnabled('imageGen')) {
            throw new Error('Generator obrazów jest wyłączony w ustawieniach (Ogólne → Funkcje).');
        }
        const provider = this.getProvider('image');
        const model = this.getActiveImageModel();
        if (!model) throw new Error('Nie wybrano modelu obrazów. Otwórz Ustawienia → Dostawcy LLM.');
        const signal = this.abortController ? this.abortController.signal : undefined;
        return await provider.generateImage({
            prompt: prompt,
            model: model,
            referenceImages: referenceImages,
            signal: signal
        });
    }

    async generateImageAndImport(prompt, updateStatusCallback, imageIndex) {
        updateStatusCallback("Generuję obraz...");
        try {
            const inlineData = await this.generateImageBase64(prompt, this._pendingReferenceImages);
            updateStatusCallback("Pobieram plik na dysk...");
            
            // Save via Node.js (CEP provides Node.js context)
            if (typeof require !== 'undefined') {
                const fs = require('fs');
                const path = require('path');
                
                const tempDir = await this.getProjectFootageDir();
                
                let ext = 'png';
                if (inlineData.mimeType === 'image/jpeg') ext = 'jpg';
                else if (inlineData.mimeType === 'image/webp') ext = 'webp';
                
                const fileName = `aisist_gen_${Date.now()}.${ext}`;
                const filePath = path.join(tempDir, fileName);
                
                fs.writeFileSync(filePath, inlineData.data, 'base64');
                
                if (!this.lastGeneratedImagePaths) this.lastGeneratedImagePaths = [];
                if (typeof imageIndex === 'number') {
                    this.lastGeneratedImagePaths[imageIndex] = filePath;
                } else {
                    this.lastGeneratedImagePaths.push(filePath);
                }
                
                updateStatusCallback("Importuję do After Effects...");
                
                return new Promise((resolve) => {
                    const csInterface = new CSInterface();
                    const safePath = filePath.replace(/\\/g, '\\\\');
                    csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                        resolve(res.startsWith("ERROR") ? { error: res } : { success: true, message: res, filePath: filePath });
                    });
                });
            } else {
                throw new Error("Brak dostępu do Node.js w środowisku CEP.");
            }
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    // --- SVG Generator ---
    async generateSVGAndImport(prompt, updateStatusCallback) {
        if (!this.isFeatureEnabled('svgGen')) {
            return { error: 'Generator SVG jest wyłączony w ustawieniach.' };
        }
        updateStatusCallback("Generuje grafike SVG...");
        try {
            const provider = this.getProvider('llm');
            const model = this.getActiveLLMModel();
            const signal = this.abortController ? this.abortController.signal : undefined;
            const svgPrompt = `Wygeneruj WYLACZNIE kod SVG (bez markdown, bez wyjasnien, bez otaczajacych znacznikow). Tylko czysty kod XML zaczynajacy sie od <svg i konczacy na </svg>. Wymagania: ${prompt}. SVG musi miec atrybut viewBox i byc dobrze sformatowany. Uzyj nowoczesnych stylow, gradientow i sciezek. Rozmiar 512x512 jesli nie podano inaczej.`;
            const completion = await provider.chatCompletion({
                messages: [{ role: 'user', parts: [{ text: svgPrompt }] }],
                model: model,
                generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
                signal: signal
            });
            const textOutput = completion.text || '';

            // Extract SVG from response (strip markdown if present)
            let svgMatch = textOutput.match(/<svg[\s\S]*?<\/svg>/i);
            if (!svgMatch) {
                throw new Error("Model nie zwrocil poprawnego kodu SVG.");
            }
            let svgCode = svgMatch[0];

            updateStatusCallback("Zapisuje plik SVG...");
            if (typeof require !== 'undefined') {
                const fs = require('fs');
                const path = require('path');
                const tempDir = await this.getProjectFootageDir();
                const slug = this.promptToSlug(prompt);
                const fileName = `aisist_svg_${slug}_${Date.now()}.svg`;
                const filePath = path.join(tempDir, fileName);
                fs.writeFileSync(filePath, svgCode, 'utf8');

                updateStatusCallback("Importuje SVG do After Effects...");
                return new Promise((resolve) => {
                    const csInterface = new CSInterface();
                    const safePath = filePath.replace(/\\/g, '\\\\');
                    csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                        resolve(res.startsWith("ERROR") ? { error: res } : { success: true, message: res, filePath: filePath });
                    });
                });
            } else {
                throw new Error("Brak dostepu do Node.js w srodowisku CEP.");
            }
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    // --- Image Edit / Inpainting ---
    async editImageAndImport(editPrompt, sourceImagePath, updateStatusCallback) {
        if (!this.isFeatureEnabled('imageEdit')) {
            return { error: 'Edycja obrazów jest wyłączona w ustawieniach.' };
        }
        updateStatusCallback("Edytuje obraz (AI)...");
        try {
            const fs = require('fs');
            const path = require('path');

            // Resolve source image path
            let actualPath = sourceImagePath;
            if (sourceImagePath && sourceImagePath.startsWith('last_image') && this.lastGeneratedImagePaths && this.lastGeneratedImagePaths.length > 0) {
                let imgIdx = this.lastGeneratedImagePaths.length - 1;
                const match = sourceImagePath.match(/last_image_(\d+)/);
                if (match) {
                    imgIdx = parseInt(match[1], 10);
                    if (imgIdx < 0) imgIdx = 0;
                    if (imgIdx >= this.lastGeneratedImagePaths.length) imgIdx = this.lastGeneratedImagePaths.length - 1;
                }
                actualPath = this.lastGeneratedImagePaths[imgIdx];
            }

            if (!actualPath || !fs.existsSync(actualPath)) {
                throw new Error("Plik zrodlowy nie istnieje: " + (actualPath || 'brak'));
            }

            // Read source image as base64
            const ext = actualPath.split('.').pop().toLowerCase();
            let mimeType = 'image/png';
            if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
            else if (ext === 'webp') mimeType = 'image/webp';
            const imgBase64 = fs.readFileSync(actualPath, 'base64');

            updateStatusCallback("Wysylam obraz do edycji AI...");
            // Use the image provider abstraction (works for Gemini and OpenRouter image-capable models)
            const resultData = await this.generateImageBase64(editPrompt, [
                { mimeType: mimeType, data: imgBase64 }
            ]);
            if (!resultData || !resultData.data) {
                throw new Error("API nie zwrocilo edytowanego obrazu.");
            }

            updateStatusCallback("Zapisuje edytowany obraz...");
            let outExt = 'png';
            if (resultData.mimeType === 'image/jpeg') outExt = 'jpg';
            else if (resultData.mimeType === 'image/webp') outExt = 'webp';

            const tempDir = await this.getProjectFootageDir();
            const slug = this.promptToSlug(editPrompt);
            const fileName = `aisist_edit_${slug}_${Date.now()}.${outExt}`;
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, resultData.data, 'base64');

            if (!this.lastGeneratedImagePaths) this.lastGeneratedImagePaths = [];
            this.lastGeneratedImagePaths.push(filePath);

            updateStatusCallback("Importuje edytowany obraz do After Effects...");
            return new Promise((resolve) => {
                const csInterface = new CSInterface();
                const safePath = filePath.replace(/\\/g, '\\\\');
                csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                    resolve(res.startsWith("ERROR") ? { error: res } : { success: true, message: res, filePath: filePath });
                });
            });
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    async generateVideoAndImport(videoDef, updateStatusCallback) {
        if (!this.isFeatureEnabled('videoGen')) {
            return { error: 'Generator wideo jest wyłączony w ustawieniach (Ogólne → Funkcje).' };
        }
        if (!this.replicateApiKey) {
            return { error: "Brak klucza API Replicate. Skonfiguruj go w ustawieniach." };
        }
        updateStatusCallback("Przygotowuję żądanie do Grok Video...");
        try {
            const prompt = videoDef.prompt || "";
            let source = videoDef.source;
            let duration = parseInt(videoDef.duration, 10) || 5;
            let aspect_ratio = videoDef.aspect_ratio || "auto";

            let imageBase64DataUri = undefined;
            if (source && source.startsWith('last_image') && this.lastGeneratedImagePaths && this.lastGeneratedImagePaths.length > 0) {
                const fs = require('fs');
                let imgIndex = this.lastGeneratedImagePaths.length - 1;
                const match = source.match(/last_image_(\d+)/);
                if (match) {
                    imgIndex = parseInt(match[1]);
                    if (imgIndex < 0) imgIndex = 0;
                    if (imgIndex >= this.lastGeneratedImagePaths.length) imgIndex = this.lastGeneratedImagePaths.length - 1;
                }
                const lastPath = this.lastGeneratedImagePaths[imgIndex];
                if (fs.existsSync(lastPath)) {
                    const ext = lastPath.split('.').pop().toLowerCase();
                    let mimeType = 'image/jpeg';
                    if (ext === 'png') mimeType = 'image/png';
                    else if (ext === 'webp') mimeType = 'image/webp';
                    
                    const base64Str = fs.readFileSync(lastPath, 'base64');
                    imageBase64DataUri = `data:${mimeType};base64,${base64Str}`;
                }
            }

            const payload = {
                input: {
                    prompt: prompt,
                    duration: duration,
                    aspect_ratio: aspect_ratio
                }
            };
            if (imageBase64DataUri) {
                payload.input.image = imageBase64DataUri;
            }

            updateStatusCallback("Zlecam render wideo (Grok)...");

            const postRes = await fetch("https://api.replicate.com/v1/models/xai/grok-imagine-video/predictions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.replicateApiKey}`,
                    "Content-Type": "application/json",
                    "Prefer": "wait=3"
                },
                body: JSON.stringify(payload),
                signal: this.abortController ? this.abortController.signal : undefined
            });

            if (!postRes.ok) {
                const errTxt = await postRes.text();
                throw new Error(`Replicate API Error: ${errTxt}`);
            }

            let prediction = await postRes.json();
            const getUrl = prediction.urls.get;

            while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
                if (this.isAborted) throw new Error("AbortError");
                updateStatusCallback(`Renderowanie Grok (Status: ${prediction.status})...`);
                await new Promise(r => setTimeout(r, 4000));
                
                const getRes = await fetch(getUrl, {
                    headers: { "Authorization": `Bearer ${this.replicateApiKey}` },
                    signal: this.abortController ? this.abortController.signal : undefined
                });
                prediction = await getRes.json();
            }

            if (prediction.status !== "succeeded") {
                throw new Error(`Błąd renderowania Replicate: ${prediction.error || prediction.status}`);
            }

            const videoUrl = prediction.output;
            if (!videoUrl) throw new Error("API nie zwróciło linku do wideo.");

            updateStatusCallback("Pobieram plik wideo na dysk...");
            
            if (typeof require !== 'undefined') {
                const fs = require('fs');
                const path = require('path');
                
                const fetchMp4 = await fetch(videoUrl, { signal: this.abortController ? this.abortController.signal : undefined });
                const buffer = await fetchMp4.arrayBuffer();
                
                const tempDir = await this.getProjectFootageDir();
                const slug = this.promptToSlug(prompt);
                const fileName = `aisist_vid_${slug}_${Date.now()}.mp4`;
                const filePath = path.join(tempDir, fileName);
                
                fs.writeFileSync(filePath, Buffer.from(buffer));
                
                updateStatusCallback("Importuję wideo do After Effects...");
                
                return new Promise((resolve) => {
                    const csInterface = new CSInterface();
                    const safePath = filePath.replace(/\\/g, '\\\\');
                    csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                        resolve(res.startsWith("ERROR") ? { error: res } : { success: true, message: res });
                    });
                });
            } else {
                throw new Error("Brak dostępu do Node.js w CEP.");
            }
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    async generateSpeechBase64(prompt) {
        if (!this.apiKey) {
            throw new Error('TTS używa Gemini API — wprowadź klucz Gemini w ustawieniach (Zakładka Klucze API).');
        }
        let ttsPromptText = prompt;
        let voiceName = this.ttsVoice;

        if (this.ttsVoice === 'Auto') {
            const match = ttsPromptText.match(/^\[?([a-zA-Z]+)\]?:\s*(.+)/);
            if (match && match[1]) {
                voiceName = match[1].toLowerCase();
                ttsPromptText = match[2];
            } else {
                voiceName = 'charon';
            }
        }

        const validVoices = ['achernar', 'achird', 'algenib', 'algieba', 'alnilam', 'aoede', 'autonoe', 'callirrhoe', 'charon', 'despina', 'enceladus', 'erinome', 'fenrir', 'gacrux', 'iapetus', 'kore', 'laomedeia', 'leda', 'orus', 'puck', 'pulcherrima', 'rasalgethi', 'sadachbia', 'sadaltager', 'schedar', 'sulafat', 'umbriel', 'vindemiatrix', 'zephyr', 'zubenelgenubi'];
        if (!validVoices.includes(voiceName.toLowerCase())) {
            voiceName = 'charon';
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.ttsModel}:generateContent?key=${this.apiKey}`;
        const payload = {
            contents: [{
                parts: [{ text: ttsPromptText }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voiceName
                        }
                    }
                }
            }
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: this.abortController ? this.abortController.signal : undefined
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        
        if (!data.candidates || data.candidates.length === 0) {
            throw new Error(`Odmowa API (brak candidates): Prawdopodobnie blokada regionalna lub polityka bezpieczeństwa Google.`);
        }
        
        const candidate = data.candidates[0];
        if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKLIST') {
            throw new Error(`Zablokowano przez filtry bezpieczeństwa (powód API: ${candidate.finishReason}).`);
        }
        if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0 || !candidate.content.parts[0].inlineData) {
            throw new Error(`Błąd API: Brak wygenerowanej treści audio w odpowiedzi (spróbuj zmienić model lub użyć VPN).`);
        }

        return candidate.content.parts[0].inlineData.data; // Raw PCM base64
    }

    createWavHeader(pcmDataLength, sampleRate, channels, bitDepth) {
        sampleRate = sampleRate || 24000;
        channels = channels || 1;
        bitDepth = bitDepth || 16;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcmDataLength, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM format = 1
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
        header.writeUInt16LE(channels * (bitDepth / 8), 32);
        header.writeUInt16LE(bitDepth, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcmDataLength, 40);
        return header;
    }

    async generateSpeechAndImport(prompt, updateStatusCallback) {
        if (!this.isFeatureEnabled('ttsGen')) {
            return { error: 'Generator TTS jest wyłączony w ustawieniach (Ogólne → Funkcje).' };
        }
        const useEleven = (this.ttsProvider === 'elevenlabs');
        updateStatusCallback(useEleven ? 'Generuję głos (ElevenLabs)...' : 'Generuję dźwięk (Gemini TTS)...');
        try {
            const fs = require('fs');
            const path = require('path');
            const tempDir = await this.getProjectFootageDir();
            const slug = this.promptToSlug(prompt);
            let filePath, audioDurationSec, audioBuffer;

            if (useEleven) {
                // Detect [VoiceName: text] prefix for gender hint or explicit override
                let voiceId = '';
                let actualText = prompt;
                const prefixMatch = prompt.match(/^\[?([a-zA-Z_\-]+)\]?:\s*([\s\S]+)/);
                if (prefixMatch) {
                    const tag = prefixMatch[1].toLowerCase();
                    actualText = prefixMatch[2];
                    if (/^(m|male|man|mężczyzna|mezczyzna)$/.test(tag)) {
                        voiceId = this.elevenlabsMaleVoice;
                    } else if (/^(f|female|woman|kobieta)$/.test(tag)) {
                        voiceId = this.elevenlabsFemaleVoice;
                    } else if (/^[a-z0-9_-]{15,}$/i.test(prefixMatch[1])) {
                        // Looks like a direct voice_id
                        voiceId = prefixMatch[1];
                    }
                }
                if (!voiceId) voiceId = this.resolveElevenLabsVoice();
                if (!voiceId) {
                    return { error: 'ElevenLabs: nie wybrano voice_id. Otwórz Ustawienia → TTS/STT i wybierz domyślny głos.' };
                }
                const client = this.getElevenLabsClient();
                const signal = this.abortController ? this.abortController.signal : undefined;
                const fmt = this.elevenlabsOutputFormat || 'mp3_44100_128';
                updateStatusCallback('ElevenLabs: synteza głosu (' + this.elevenlabsModel + ')...');
                const res = await client.textToSpeech(actualText, voiceId, this.elevenlabsModel, this.elevenlabsVoiceSettings, fmt, signal);
                audioBuffer = Buffer.from(res.buffer);
                const ext = fmt.startsWith('mp3') ? 'mp3'
                          : fmt.startsWith('pcm') ? 'wav'
                          : fmt.startsWith('opus') ? 'opus'
                          : 'mp3';
                if (ext === 'wav') {
                    // Wrap PCM in WAV header — assume 24kHz mono 16-bit
                    const sr = /pcm_(\d+)/.exec(fmt);
                    const sampleRate = sr ? parseInt(sr[1], 10) : 24000;
                    const wavHeader = this.createWavHeader(audioBuffer.length, sampleRate);
                    audioBuffer = Buffer.concat([wavHeader, audioBuffer]);
                    audioDurationSec = Math.round((audioBuffer.length - 44) / (sampleRate * 2));
                } else {
                    // For MP3 we can't easily measure duration; estimate from text length (rough: 15 chars/sec)
                    audioDurationSec = Math.max(1, Math.round(actualText.length / 15));
                }
                filePath = path.join(tempDir, `aisist_tts_${slug}_${Date.now()}.${ext}`);
                fs.writeFileSync(filePath, audioBuffer);
            } else {
                const pcmBase64 = await this.generateSpeechBase64(prompt);
                const pcmBuffer = Buffer.from(pcmBase64, 'base64');
                const wavHeader = this.createWavHeader(pcmBuffer.length);
                audioBuffer = Buffer.concat([wavHeader, pcmBuffer]);
                audioDurationSec = Math.round(pcmBuffer.length / (24000 * 2));
                filePath = path.join(tempDir, `aisist_tts_${slug}_${Date.now()}.wav`);
                fs.writeFileSync(filePath, audioBuffer);
            }

            this.lastTtsDurationSec = audioDurationSec;
            if (!this.lastGeneratedAudioPaths) this.lastGeneratedAudioPaths = [];
            this.lastGeneratedAudioPaths.push(filePath);

            updateStatusCallback('Importuję audio do After Effects...');
            return new Promise((resolve) => {
                const csInterface = new CSInterface();
                const safePath = filePath.replace(/\\/g, '\\\\');
                csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                    resolve(res.startsWith('ERROR') ? { error: res } : { success: true, message: res, filePath: filePath, durationSec: audioDurationSec });
                });
            });
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    async generateMusicAndImport(prompt, updateStatusCallback) {
        if (!this.isFeatureEnabled('musicGen')) {
            return { error: 'Generator muzyki jest wyłączony w ustawieniach.' };
        }
        // Route based on configured music provider
        if (this.musicProvider === 'elevenlabs') {
            return this.generateElevenMusicAndImport(prompt, updateStatusCallback);
        }
        if (!this.apiKey) {
            return { error: 'Klucz Gemini API nie jest ustawiony w ustawieniach.' };
        }

        updateStatusCallback("Zlecam kompozycję muzyczną: Gemini Lyria 3 Pro (Audio+Text)...");
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=${this.apiKey}`;
            
            const payload = {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    responseModalities: ["AUDIO", "TEXT"]
                }
            };

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload),
                signal: this.abortController ? this.abortController.signal : undefined
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error ? errorData.error.message : 'Błąd generowania muzyki (Lyria)');
            }

            const data = await response.json();
            
            if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts) {
                throw new Error("Otrzymano pustą lub błędną strukturę odpowiedzi z API Lyria 3.");
            }
            
            let audioBase64 = null;
            let lyricsText = "";

            // FIX: previously concatenated unrelated system rules into lyricsText (string corruption bug).
            for (const part of data.candidates[0].content.parts) {
                if (part.text) {
                    lyricsText += part.text;
                } else if (part.inlineData && part.inlineData.data) {
                    audioBase64 = part.inlineData.data;
                }
            }

            if (!audioBase64) {
                throw new Error("Błąd: API Lyria zwróciło poprawny kod, ale brak `inlineData` zawierającego muzykę. Upewnij się, że opcja responseModalities została zaakceptowana.");
            }

            // Jeśli wygenerowało słowa piosenki, zapiszmy je do logów LTM lub wklejmy info.
            if (lyricsText.trim().length > 0) {
                this.longTermMemory.push({
                    id: Date.now() + Math.random(),
                    type: 'system',
                    content: `Wygenerowano strukture utworu: \n${lyricsText.trim()}`
                });
                console.log("Lyrics / Structure generated:\n" + lyricsText);
            }

            updateStatusCallback("Pobieranie zakończone. Zapisuję plik MP3 do importu...");
            
            if (typeof require !== 'undefined') {
                const fs = require('fs');
                const path = require('path');
                
                const mp3Buffer = Buffer.from(audioBase64, 'base64');
                const tempDir = await this.getProjectFootageDir();
                // Lyria 3 clip / pro always returns an mp3 by default for standard prompts
                const slug = this.promptToSlug(prompt);
                const fileName = `aisist_music_${slug}_${Date.now()}.mp3`;
                const filePath = path.join(tempDir, fileName);
                
                fs.writeFileSync(filePath, mp3Buffer);
                
                if (!this.lastGeneratedAudioPaths) this.lastGeneratedAudioPaths = [];
                this.lastGeneratedAudioPaths.push(filePath);
                
                updateStatusCallback("Importuję utwór Lyria 3 do After Effects...");
                
                return new Promise((resolve) => {
                    const csInterface = new CSInterface();
                    const safePath = filePath.replace(/\\/g, '\\\\');
                    csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res) => {
                        resolve(res.startsWith("ERROR") ? { error: res } : { success: true, message: res });
                    });
                });
            } else {
                throw new Error("Brak dostępu do Node.js (modułów 'fs') w CEP.");
            }
        } catch(e) {
            console.error(e);
            return { error: e.message };
        }
    }

    // ------- ElevenLabs SFX (Text-to-Sound-Effects) -----------------------
    // sfxDef may be a string (prompt) or an object: { prompt, duration_seconds, prompt_influence, loop }
    async generateSFXAndImport(sfxDef, updateStatusCallback) {
        if (!this.isFeatureEnabled('sfxGen')) {
            return { error: 'Generator SFX jest wyłączony w ustawieniach (Ogólne → Funkcje).' };
        }
        if (!this.elevenlabsApiKey) {
            return { error: 'Brak klucza ElevenLabs. Skonfiguruj go w ustawieniach (Klucze API).' };
        }
        try {
            const fs = require('fs');
            const path = require('path');
            const item = (typeof sfxDef === 'string') ? { prompt: sfxDef } : (sfxDef || {});
            const prompt = item.prompt || item.text || '';
            if (!prompt) return { error: 'SFX: brak prompta tekstowego.' };

            updateStatusCallback('ElevenLabs SFX: generuję efekt dźwiękowy...');
            const client = this.getElevenLabsClient();
            const signal = this.abortController ? this.abortController.signal : undefined;
            // Choose format - default to MP3 (small, compatible with AE)
            const fmt = item.output_format || this.elevenlabsOutputFormat || 'mp3_44100_128';
            const opts = {
                outputFormat: fmt,
                duration_seconds: item.duration_seconds || (this.elevenlabsSfxDefaultDuration > 0 ? this.elevenlabsSfxDefaultDuration : undefined),
                prompt_influence: (item.prompt_influence != null) ? item.prompt_influence : this.elevenlabsSfxPromptInfluence,
                loop: item.loop === true,
                model_id: item.model_id,
                signal: signal
            };
            const res = await client.generateSFX(prompt, opts);
            updateStatusCallback('SFX wygenerowany, zapisuję...');

            let audioBuffer = Buffer.from(res.buffer);
            let ext = 'mp3';
            if (fmt.startsWith('pcm')) {
                const sr = /pcm_(\d+)/.exec(fmt);
                const sampleRate = sr ? parseInt(sr[1], 10) : 24000;
                const wavHeader = this.createWavHeader(audioBuffer.length, sampleRate);
                audioBuffer = Buffer.concat([wavHeader, audioBuffer]);
                ext = 'wav';
            } else if (fmt.startsWith('opus')) { ext = 'opus'; }

            const tempDir = await this.getProjectFootageDir();
            const slug = this.promptToSlug(prompt);
            const fileName = `aisist_sfx_${slug}_${Date.now()}.${ext}`;
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, audioBuffer);

            if (!this.lastGeneratedAudioPaths) this.lastGeneratedAudioPaths = [];
            this.lastGeneratedAudioPaths.push(filePath);

            updateStatusCallback('Importuję SFX do After Effects...');
            return new Promise((resolve) => {
                const csInterface = new CSInterface();
                const safePath = filePath.replace(/\\/g, '\\\\');
                csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res2) => {
                    resolve(res2.startsWith('ERROR') ? { error: res2 } : { success: true, message: res2, filePath: filePath });
                });
            });
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    // ------- ElevenLabs Music (Eleven Music) -----------------------------
    // musicDef may be a string or { prompt, duration_seconds, force_instrumental, composition_plan, model_id }
    async generateElevenMusicAndImport(musicDef, updateStatusCallback) {
        if (!this.isFeatureEnabled('musicGen')) {
            return { error: 'Generator muzyki jest wyłączony w ustawieniach.' };
        }
        if (!this.elevenlabsApiKey) {
            return { error: 'Brak klucza ElevenLabs. Skonfiguruj go w ustawieniach (Klucze API).' };
        }
        try {
            const fs = require('fs');
            const path = require('path');
            const item = (typeof musicDef === 'string') ? { prompt: musicDef } : (musicDef || {});
            let prompt = item.prompt || item.text || '';
            if (!prompt) return { error: 'Music: brak prompta tekstowego.' };

            // Try to honour TTS duration if previously measured (so music tracks fit voiceover)
            let durationSec = item.duration_seconds;
            if (!durationSec && this.lastTtsDurationSec && this.lastTtsDurationSec > 0) {
                durationSec = Math.max(10, Math.min(300, this.lastTtsDurationSec));
            }

            const forceInstr = (item.force_instrumental != null) ? !!item.force_instrumental : this.elevenlabsMusicForceInstrumental;
            updateStatusCallback('ElevenLabs Music: komponuję utwór' + (durationSec ? ' (' + Math.round(durationSec) + 's)' : '') + (forceInstr ? ' [instrumental]' : '') + '...');
            const client = this.getElevenLabsClient();
            const signal = this.abortController ? this.abortController.signal : undefined;
            const fmt = item.output_format || this.elevenlabsOutputFormat || 'mp3_44100_128';
            const opts = {
                outputFormat: fmt,
                duration_seconds: durationSec,
                force_instrumental: forceInstr,
                composition_plan: item.composition_plan,
                model_id: item.model_id,
                signal: signal
            };
            const res = await client.composeMusic(prompt, opts);
            updateStatusCallback('Utwór gotowy, zapisuję...');

            let audioBuffer = Buffer.from(res.buffer);
            let ext = 'mp3';
            if (fmt.startsWith('pcm')) {
                const sr = /pcm_(\d+)/.exec(fmt);
                const sampleRate = sr ? parseInt(sr[1], 10) : 44100;
                const wavHeader = this.createWavHeader(audioBuffer.length, sampleRate);
                audioBuffer = Buffer.concat([wavHeader, audioBuffer]);
                ext = 'wav';
            } else if (fmt.startsWith('opus')) { ext = 'opus'; }

            const tempDir = await this.getProjectFootageDir();
            const slug = this.promptToSlug(prompt);
            const fileName = `aisist_music_${slug}_${Date.now()}.${ext}`;
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, audioBuffer);

            if (!this.lastGeneratedAudioPaths) this.lastGeneratedAudioPaths = [];
            this.lastGeneratedAudioPaths.push(filePath);

            updateStatusCallback('Importuję utwór ElevenLabs do After Effects...');
            return new Promise((resolve) => {
                const csInterface = new CSInterface();
                const safePath = filePath.replace(/\\/g, '\\\\');
                csInterface.evalScript(`importAndAddToComp("${safePath}")`, (res2) => {
                    resolve(res2.startsWith('ERROR') ? { error: res2 } : { success: true, message: res2, filePath: filePath, durationSec: durationSec || null });
                });
            });
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    async transcribeAudio(source, updateStatusCallback) {
        if (!this.isFeatureEnabled('sttGen')) {
            return { error: 'Speech-to-Text jest wyłączony w ustawieniach (Ogólne → Funkcje).' };
        }
        if (!this.elevenlabsApiKey) {
            return { error: 'Brak klucza ElevenLabs. Skonfiguruj go w ustawieniach (Klucze API).' };
        }
        try {
            const fs = require('fs');
            const path = require('path');

            // Resolve audio source — accept 'last_audio', 'last_tts', or full path
            let audioPath = source;
            if (source === 'last_audio' || source === 'last_tts') {
                if (!this.lastGeneratedAudioPaths || this.lastGeneratedAudioPaths.length === 0) {
                    return { error: 'Brak wygenerowanego pliku audio. Najpierw wygeneruj TTS lub podaj pełną ścieżkę.' };
                }
                audioPath = this.lastGeneratedAudioPaths[this.lastGeneratedAudioPaths.length - 1];
            }
            if (!fs.existsSync(audioPath)) {
                return { error: 'Plik audio nie istnieje: ' + audioPath };
            }
            updateStatusCallback('ElevenLabs Scribe: transkrypcja (' + path.basename(audioPath) + ')...');
            const buffer = fs.readFileSync(audioPath);
            const ext = path.extname(audioPath).toLowerCase();
            const mime = ext === '.mp3' ? 'audio/mpeg'
                       : ext === '.wav' ? 'audio/wav'
                       : ext === '.ogg' ? 'audio/ogg'
                       : ext === '.flac' ? 'audio/flac'
                       : ext === '.m4a' ? 'audio/mp4'
                       : 'application/octet-stream';
            const client = this.getElevenLabsClient();
            const signal = this.abortController ? this.abortController.signal : undefined;
            const data = await client.speechToText(buffer, this.elevenlabsSttModel, {
                mimeType: mime,
                filename: path.basename(audioPath),
                tag_audio_events: true,
                diarize: false,
                signal: signal
            });
            // Persist transcription file next to audio for re-use
            try {
                const outPath = audioPath.replace(/\.[^.]+$/, '_transcript.json');
                fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
            } catch (_) {}
            return { success: true, message: JSON.stringify(data.words || data) };
        } catch (err) {
            console.error(err);
            return { error: err.message };
        }
    }

    async sendPromptToModel(userPrompt, aeContextStr, errorFeedback = null, snapshotData = null, attachedImages = null) {
        // ---- Build message body ----------------------------------------
        let messageText = `KONTEKST AFTER EFFECTS:\n${aeContextStr}\n\nKOMUNIKAT LUB ZADANIE:\n${userPrompt}`;
        if (errorFeedback) {
            if (errorFeedback.startsWith("WYNIK ZADAŃ RÓWNOLEGŁYCH")) {
                messageText += `\n\n[SYSTEM]:\n${errorFeedback}`;
            } else {
                messageText += `\n\nUWAGA BŁĄD! Poprzednio wykonany kod wyrzucił wyjątek ExtendScript. Zbadaj i popraw swój skrypt. Treść błędu:\n${errorFeedback}`;
            }
        }

        const userParts = [{ text: messageText }];
        if (snapshotData) {
            userParts.push({ inlineData: { mimeType: snapshotData.mimeType, data: snapshotData.data } });
        }
        if (attachedImages && Array.isArray(attachedImages)) {
            attachedImages.forEach(img => {
                if (img && img.mimeType && img.data) {
                    userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
                }
            });
        }
        const userMsg = { role: "user", parts: userParts };

        // ---- Call active LLM provider ----------------------------------
        const provider = this.getProvider('llm');
        const model = this.getActiveLLMModel();
        if (!model) throw new Error('Nie wybrano modelu dla dostawcy ' + this.llmProvider + '. Otwórz Ustawienia → Dostawcy LLM.');

        const signal = this.abortController ? this.abortController.signal : undefined;
        const completion = await provider.chatCompletion({
            systemInstruction: this.systemInstruction,
            messages: [...this.history, userMsg],
            model: model,
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 16384,
                responseMimeType: 'application/json'
            },
            // Grounding works only for Gemini today AND must be enabled in feature flags
            grounding: this.llmProvider === 'gemini' && this.useGrounding && this.isFeatureEnabled('grounding'),
            signal: signal
        });
        const rawText = completion.text || '';

        // ---- Save to history (no binary blobs, to prevent token explosion) --
        this.history.push({
            role: "user",
            parts: [{
                text: messageText
                    + (snapshotData ? "\n[Załączono automatyczny zrzut ekranu kompozycji dla weryfikacji]" : "")
                    + (attachedImages && attachedImages.length > 0
                        ? `\n[Załączono ${attachedImages.length} manualnych obrazów referencyjnych od użytkownika]`
                        : "")
            }]
        });
        this.history.push({ role: "model", parts: [{ text: rawText }] });
        if (this.history.length > this.MAX_HISTORY_TURNS) {
            this.history = this.history.slice(this.history.length - this.MAX_HISTORY_TURNS);
        }

        // ---- Parse JSON (with repair fallback) -------------------------
        try {
            let jsonText = rawText.trim();
            jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
            const start = jsonText.indexOf('{');
            const end = jsonText.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                jsonText = jsonText.substring(start, end + 1);
            }
            return JSON.parse(jsonText);
        } catch (e) {
            // Robust JSON repair for truncated responses
            try {
                let repaired = rawText.trim();
                repaired = repaired.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
                const startIdx = repaired.indexOf('{');
                if (startIdx !== -1) {
                    repaired = repaired.substring(startIdx);
                }
                // Remove trailing commas before closing brackets
                repaired = repaired.replace(/,\s*([}\]])/g, '$1');
                // Close any unclosed strings (find last unescaped open quote)
                let inString = false;
                let lastQuotePos = -1;
                for (let i = 0; i < repaired.length; i++) {
                    if (repaired[i] === '"' && (i === 0 || repaired[i-1] !== '\\')) {
                        inString = !inString;
                        if (inString) lastQuotePos = i;
                    }
                }
                if (inString) {
                    repaired += '"';
                }
                // Count and close unclosed brackets/braces
                let openBraces = 0, openBrackets = 0;
                let inStr = false;
                for (let i = 0; i < repaired.length; i++) {
                    if (repaired[i] === '"' && (i === 0 || repaired[i-1] !== '\\')) inStr = !inStr;
                    if (!inStr) {
                        if (repaired[i] === '{') openBraces++;
                        else if (repaired[i] === '}') openBraces--;
                        else if (repaired[i] === '[') openBrackets++;
                        else if (repaired[i] === ']') openBrackets--;
                    }
                }
                // Remove trailing incomplete key-value pairs (e.g., `"code":` with no value)
                repaired = repaired.replace(/,?\s*"[^"]*"\s*:\s*$/g, '');
                // Close remaining open structures
                for (let i = 0; i < openBrackets; i++) repaired += ']';
                for (let i = 0; i < openBraces; i++) repaired += '}';
                
                const parsed = JSON.parse(repaired);
                // Ensure required fields exist with safe defaults
                if (!parsed.thought) parsed.thought = '(auto-repaired truncated response)';
                if (!parsed.code) parsed.code = [];
                if (parsed.is_task_complete === undefined) parsed.is_task_complete = false;
                if (!parsed.message) parsed.message = 'Kontynuuję...';
                console.warn("JSON auto-repaired successfully from truncated response");
                return parsed;
            } catch (e2) {
                console.error("Failed to parse AND repair JSON", rawText);
                throw new Error("Model_JSON_Error: Model nie zwrócił poprawnego JSON-a. Raw output:\n" + rawText);
            }
        }
    }
}
