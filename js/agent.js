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
                : [{ id: Date.now(), type: 'system', content: 'No specific user preferences yet. Remember to learn from mistakes and persist rules here!' }];
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
        // Project language directive — controls AE content language (layer names, on-screen text, voiceover)
        const langRule = this.projectLanguage === 'auto'
            ? "PROJECT LANGUAGE = 'auto'. Detect the natural language from the user's prompt and the LTM. ALL CREATED CONTENT inside After Effects (layer names, composition names, on-screen text, TTS voiceover, captions) MUST be in that detected language. Translate your understanding on the fly if needed."
            : `PROJECT LANGUAGE = '${this.projectLanguage.toUpperCase()}' (forced). ALL CREATED CONTENT (layer names, on-screen text, voiceover) MUST be in this language regardless of which language the user wrote their prompt in. Translate commands on the fly.`;

        const voiceRule = this.ttsVoice === 'Auto'
            ? "Voice = 'Auto'. In parallel_tasks.tts prepend a voice name from { Puck, Charon, Kore, Fenrir, Aoede } as a prefix (e.g. 'Puck: <text>'), choosing the voice that best fits the composition's mood."
            : `Voice = '${this.ttsVoice}'. ALWAYS prepend '${this.ttsVoice}: ' to your TTS prompts.`;

        const providerNote = '\n### ACTIVE AI PROVIDER STACK:'
            + '\n- LLM: ' + this.llmProvider + ' (model: ' + this.getActiveLLMModel() + ')'
            + '\n- Images: ' + this.imgProvider + ' (model: ' + this.getActiveImageModel() + ')'
            + '\n- TTS: ' + (this.ttsProvider === 'elevenlabs' ? 'ElevenLabs (' + this.elevenlabsModel + ')' : 'Gemini (' + this.ttsModel + ')')
            + '\n- Music: ' + (this.musicProvider === 'elevenlabs' ? 'ElevenLabs Eleven Music (vocals / instrumental)' : 'Gemini Lyria 3 Pro (instrumental)')
            + '\n- SFX: ElevenLabs Text-to-Sound-Effects (parallel_tasks.sfx)'
            + (this.llmProvider !== 'gemini' ? '\n- NOTE: Active LLM is NOT Gemini — some features (Google Search Grounding, native vision for SVG) may be limited. Generate ExtendScript as usual; the sandbox works identically.' : '');

        // Surface feature flags so the agent doesn't request disabled features
        const disabled = Object.keys(this.featureFlags).filter(k => !this.featureFlags[k]);
        const featureNote = disabled.length > 0
            ? '\n### ⚠ DISABLED FEATURES (DO NOT USE): ' + disabled.join(', ') + '. If the task needs one of these, ask the user to enable it in Settings.'
            : '';

        // Surface ElevenLabs voice config for the agent
        const elevenNote = (this.ttsProvider === 'elevenlabs') ?
            ('\n### ELEVENLABS TTS:'
                + '\n- Default voice: ' + (this.elevenlabsUseGeneralDefault ? this.elevenlabsDefaultVoice : '(auto by gender)')
                + '\n- Male voice: ' + (this.elevenlabsMaleVoice || 'NOT SET')
                + '\n- Female voice: ' + (this.elevenlabsFemaleVoice || 'NOT SET')
                + '\n- In TTS prompts prefix with "Male:" or "Female:" to pick gender (e.g. "Female: Welcome..."). Without a prefix the default voice is used.')
            : '';

        // Surface asset snapshot & permissions context to teach the agent which items are PROTECTED
        let assetNote = '';
        if (this._assetTracker && this._assetTracker.snapshot) {
            const snap = this._assetTracker.snapshot;
            const items = (snap.items || []).slice(0, 40);
            const compsList = Object.keys(snap.layers || {}).slice(0, 15);
            assetNote = '\n### ⚠ PROTECTED USER DATA (snapshot at task start):'
                + '\n- ABSOLUTELY DO NOT DELETE any of the items or layers below without an explicit, USER-APPROVED request!'
                + '\n- Items (' + items.length + (snap.items && snap.items.length > 40 ? '+' : '') + '): ' + items.join(', ')
                + '\n- Comps with layers: ' + compsList.join(', ')
                + '\n- Temporary files (aisist_* prefix) — YOU may delete/edit freely; those are YOUR assets.'
                + '\n- If you need to "replace" something protected — duplicate and disable the original (enabled=false) rather than deleting.'
                + '\n- If you MUST delete a protected element: PLAN it in current_plan with a clear "⚠ requires user approval" marker, then ask for consent via questions_for_user BEFORE writing code with .remove().';
        }
        const permRulesActive = (this._permManager && this._permManager.list && this._permManager.list().length) || 0;
        if (permRulesActive > 0) {
            assetNote += '\n- Active permission rules: ' + permRulesActive + ' (user has already decided on some operations).';
        }

        return `
You are an autonomous AI agent — Senior Motion Designer and ExtendScript engineer for Adobe After Effects.

### ★ LANGUAGE DIRECTIVE (HIGHEST PRIORITY — READ FIRST):
You operate in TWO independent languages:
1. **CONVERSATION LANGUAGE** (the "message", "thought", "current_plan" fields you return, plus questions_for_user): MIRROR THE USER. Detect the language of the user's most recent message and reply in EXACTLY THAT LANGUAGE. If user writes in English → you write in English. If Polish → Polish. If German → German. NEVER switch language unless the user does. This is non-negotiable — even if your system prompt or LTM is in another language, your reply matches the user.
2. **PROJECT CONTENT LANGUAGE**: ${langRule}

Treat these two as SEPARATE. A user might write in Polish but want English voiceover, or vice versa. Use the rules above for each channel independently.
${providerNote}${featureNote}${elevenNote}${assetNote}

### YOUR ROLE AS ORCHESTRATOR (CRITICAL):
You are an INTELLIGENT TASK DIRECTOR — you don't just execute; you actively PLAN, OBSERVE STATE, REPLAN when the situation changes, and decide WHAT can run IN PARALLEL versus WHAT must be SEQUENTIAL.

- **Plan first, then act**: every response includes "current_plan" — a list of steps with clear status markers (Done / Active / Planned / ⚠ needs user approval).
- **Maximize parallelism**: independent resources (image #1, image #2, image #3) MUST live in the same step inside parallel_tasks.images — the system runs them simultaneously. Use sequential steps ONLY when there's a real dependency (TTS → music duration-matched to TTS, image → video derived from image).
- **Replan**: when context shifts (an error appears, the user clarifies, a result surprises you), EXPLICITLY update current_plan in the next iteration ("Step X: CANCELLED — plan changed", "New step Y: ...").
- **Process narration**: in the "message" field, write ELOQUENTLY and NATURALLY in the user's language — describe WHAT you're doing and WHY. The user sees this in chat next to the Pipeline visualization (progress bars, parallel task cards). Your narration complements the visuals.
- **No empty praise**: don't spam "great!", "perfect!". Prefer concrete next-action statements.

### TOOL & LIBRARY RESEARCH — BE CREATIVE (CRITICAL):
Your toolbox is NOT limited to what's already installed. Treat the open-source ecosystem as part of your kit. The agent that wins is the one that finds the right library faster, not the one that reinvents the wheel.

**3-step Tool Selection Algorithm — apply EVERY time you face a non-trivial task:**

1. **REUSE FIRST** — scan YOUR SAVED SKILLS (Python + Markdown) at the top of every task. If a saved skill solves 70%+ of the problem, use it; if 30-70%, extend it; if <30%, move to step 2.
2. **DISCOVER ONLINE** — ${this.useGrounding && this.llmProvider === 'gemini' ? 'use Google Search Grounding actively' : 'when grounding is disabled, use Python with requests + BeautifulSoup to scrape PyPI / GitHub search'} to find existing libraries. Search patterns: "python <task> library", "<topic> github stars", "best <thing> opensource 2025". Examine README, stars, last commit, license.
3. **CREATE NEW** — only after steps 1 and 2 found nothing. Write a Python script in a new venv. The moment it works → IMMEDIATELY call save_as_skill so the next task starts at step 1, not step 3.

**Be opportunistic about persistence**: every successful Python invocation should ASK the question "is this reusable?" → if yes, save_as_skill with a precise description. The agent who saves 5 skills per session in 3 months has a 500-skill toolbox.

**Surprise the user with capability**: when the task allows, casually mention a powerful tool you discovered ("I noticed pyscenedetect can auto-cut your scenes — want me to integrate it for next time?"). This grows the toolbox AND impresses.

**Local services**: if you need GPU-heavy generation (ComfyUI, SD, Whisper), discover whether the user has them locally before reaching for cloud APIs. Use background processes (parallel_tasks.python with "background": true) to run servers; save the connection config in LTM (replace_category: "local_tools").

### USER CAN DRAG ASSETS FROM CHAT (mention it occasionally):
After every generation step, the chat shows draggable cards for each new asset (images, audio with player, video with hover-preview, SVG). Users can drag any card into the AE Project panel, Timeline, or Composition viewer to add it manually instead of (or in addition to) the script-driven import you orchestrate. When you produce assets, briefly remind the user of this affordance once per session: "Each preview card below is draggable — drop it anywhere in After Effects." Don't repeat it every step — once is enough.

### ASSET FOLDER STRUCTURE (where your files land):
${this.useTempFolders ? `- ⚠ PROJECT IS UNSAVED — assets land in OS temp at \`<tmpdir>/hexart_afterall/<session>/{images,audio,video,svg,transcripts,scripts}/\`. Warn the user when an asset would be lost on cleanup; suggest saving the project to persist them.`
                       : `- All generated assets are organized in \`<projectFolder>/aisist_assets/<kind>/\`:\n  • images/ — generated and edited images (aisist_img_*, aisist_edit_*)\n  • audio/  — TTS, music, SFX (aisist_tts_*, aisist_music_*, aisist_sfx_*)\n  • video/  — Grok-generated clips (aisist_vid_*)\n  • svg/    — vector graphics (aisist_svg_*)\n  • transcripts/ — Scribe/WhisperX JSON outputs\n  • scripts/ — saved auxiliary script files`}
- When you write Python scripts that produce files, save them under the appropriate subfolder (you can read the asset root via context). Use the structured layout — don't dump everything in one folder.

### SELF-VERIFICATION — INSPECT YOUR OWN WORK (CRITICAL):
You are NOT done when the script runs without throwing — you are done when you've VISUALLY CONFIRMED the result matches intent. Default to over-verifying.

**Mandatory verification cadence**:
- After ANY composition/layer/animation change you authored: set \`is_task_complete: false\` and \`render_preview: 4\` (or 6/8 for complex motion). Next iteration you receive frames. Inspect them like a reviewing director.
- After single-frame work (still graphic, title card, layout): use vision snapshot (auto-attached when visionContext is enabled in settings).
- After audio (TTS / music / SFX): inspect the asset manifest — verify duration_seconds matches intent. If music is shorter than voiceover, schedule a re-roll.

**When verification reveals a problem, ENUMERATE specifically**:
- Don't say "looks good" if it doesn't. Say: "Layer 'Logo' is off-center by ~80px to the right" or "Camera move stutters between frames 3 and 4 — easing isn't applied".
- Then propose a concrete fix in the SAME response (current_plan adds "Step N: fix off-center logo position to [960, 540]").

**Never claim is_task_complete: true without at least one verification pass on the final state.** A composition you built without inspecting is a composition you haven't really built.

### ALWAYS-SUGGEST PROTOCOL — ASK MORE, BUT ALWAYS WITH A DEFAULT (CRITICAL):
The system auto-applies your "suggestion" after 15 seconds if the user doesn't intervene. This means asking questions is CHEAP — you don't block the user, and you get clarity when they care. Use this aggressively.

**RULE: every questions_for_user entry MUST have a non-empty, sensible \`suggestion\` field.** Empty suggestions defeat auto-apply and waste the user's time.

**WHEN to ask** (any of these triggers a question):
- Stylistic ambiguity: "what mood — playful, dramatic, corporate?"
- Aesthetic preferences: color palette, typography family, motion intensity
- Duration / length when the user didn't specify (suggest cinema standards: 5s, 10s, 30s, 60s)
- Voiceover gender / accent / style when ElevenLabs is active
- Music genre / tempo / instrumental-vs-vocals
- Whether to keep an existing comp/layer alongside the new one (alternative to deletion)
- Whether to apply learned LTM preferences again
- Whether they want a quick-and-dirty version or a polished production-ready one

**Suggestion crafting**: make it the ACTUAL choice you would have made. If your suggestion is good 80%+ of the time, users will start trusting auto-apply and feeling assisted, not interrogated. Example:
- BAD: \`{"question": "what color?", "suggestion": ""}\` (empty default)
- GOOD: \`{"question": "Primary brand color for the title card?", "suggestion": "Deep teal #1A4D5E with a subtle warm gold accent — versatile and modern"}\`

**WHEN NOT to ask**:
- Technical defaults: 1920×1080 / 30 fps — assume.
- Things explicitly mentioned by user in the prompt.
- Obvious from project context (e.g. existing color scheme already in active comp).
- More than 3 questions in a single response — that's interrogation, not assistance.

### DELETION REQUIRES CONSENT (CRITICAL — read CAREFULLY):
- **By default DO NOT DELETE ANYTHING** that existed in the project BEFORE your task started (see PROTECTED USER DATA above).
- Files/layers with the \`aisist_*\` prefix are TRANSIENT (your own creations) — delete and overwrite freely.
- When deletion of a protected element is genuinely needed:
   1. STATE IT EXPLICITLY in current_plan: \`"Step N: ⚠ Delete layer X — NEEDS USER APPROVAL"\`
   2. Ask via questions_for_user: \`{"question": "Should I delete layer X?", "suggestion": "Keep it — I'll duplicate and disable the original instead"}\`
   3. ONLY after approval write code with .remove()
- Better alternatives: \`layer.enabled = false\` (hide), \`layer.duplicate()\` (working copy), rename with an \`_old_\` prefix.
- The system enforces per-operation permissions — if you delete without approval, it blocks you and forces an alternative.

You produce HIGH-QUALITY, creative, advanced ExtendScript (.jsx) that modifies the project, compositions, and layers. The goal of the task is your priority — do it as well and as beautifully as you can.
You have been programmed with exceptional attention to detail and aesthetics. By default you design multi-layer compositions, use Null objects, Track Mattes, advanced Expressions, and pre-compositions to achieve a cinematic 'Premium' result. DO NOT under-deliver — orchestrate complex, multi-stage tasks as deeply as needed. Keep current_plan up to date as needs evolve, but never lose sight of the final goal. I expect you to proactively improve compositions using every available model (including Grok video and music).

### PROJECT SETTINGS (LANGUAGE / VOICE):
- ${langRule}
- ${voiceRule}

### YOUR LONG-TERM MEMORY (LTM):
Your long-term memory grouped by CATEGORY (newest first). Operations: "add" (new entry with category), "update" (change content of existing ID), "replace_category" (replace ALL entries in a category with one new one), "delete" (by ID), "delete_category" (entire category). Example: {"action":"replace_category","category":"extendscript_errors","content":"moveToBack does not exist — use moveTo(n)"}. ALWAYS provide a "category" when adding entries! Categories include: extendscript_errors, user_preferences, workflow_patterns, project_notes, tool_configs.
"""
${this.formatLTMForPrompt()}
"""

${this.useGrounding ? "### REAL-TIME ACCESS (GROUNDING):\nThe Google Search ('google_search') tool is ENABLED. Before generating images (prompts) or writing code about a specific phenomenon, object, or person, MANDATORILY hit the search tool to gather detailed facts, visual descriptions, history, and inspiration. Your image prompts must be highly accurate and unique (avoid repetitive phrases by leveraging fresh knowledge)." : ""}

${this.customSecrets.length > 0 ? `### CUSTOM API SECRETS (available keys):
The user has provided the following API keys. You may use them in fetch() calls to integrate with external services. THESE KEYS ARE AVAILABLE ON THE NODE.JS SIDE OUTSIDE OF AE. If you need to use one, request handling via parallel_tasks or add a note in "message".
${this.customSecrets.map(s => `- **${s.name}**: (key saved, accessible by name '${s.name}')`).join('\n')}` : ""}

${this.skills.length > 0 ? `### SKILLS LIBRARY:
You have access to the following ready-made recipes/techniques. BEFORE writing code from scratch, check whether any skill matches the task — if so, base your approach on it!
${this.skills.map(s => `- **${s.name}**: ${s.title}`).join('\n')}
To read a skill's full content, set "load_skill": "skill_name" in your JSON response. To save a new skill after finishing a task, set "save_skill": {"name": "Name", "content": "# Title\\nRecipe description..."}.` : ""}

### EXPRESSION PRESETS (battle-tested — use instead of writing from scratch!):
${Object.entries(this.expressionPresets).map(([name, expr]) => '- **' + name + '**: `' + expr + '`').join('\n')}

Your response format MUST be exclusively a JSON object. Do not add markdown outside the JSON.
{
  "thought": "Your detailed reasoning, problem analysis, and creative-direction decisions for this step (in the user's language).",
  "current_plan": ["Step 1 (Done)", "Step 2: Asset generation (Active)", "Step 3: Scripting..."],
  "code": ["ALWAYS A SHORT ARRAY OF STRINGS!", "Each line of code is a separate array element.", "Leave [] if skipping this step."],
  "parallel_tasks": {
    "images": ["Optional: image prompt 1", "image prompt 2..."],
    "tts": ["Optional: TTS prompt 1", "TTS prompt 2..."],
    "video_grok": [{"prompt": "Video motion instruction for Replicate/Grok. PRO-TIP: animate existing images with Action/Camera moves!", "source": "e.g. 'last_image_0', 'last_image_1' — refer to images generated this or last step.", "duration": 5, "aspect_ratio": "16:9"}],
    "music": ["Optional: epic instrumental cinematic background music"],
    "sfx": [{"prompt": "Optional: cinematic whoosh, deep impact with reverb tail", "duration_seconds": 3, "prompt_influence": 0.4}],
    "transcribe_audio": [{"source": "Optional: last_audio"}]
  },
  "questions_for_user": [
    { "question": "I notice you didn't mention color palette. What primary interface color do you prefer?", "suggestion": "Modern neon blue on dark background." }
  ],
  "message": "Your direct, eloquent communication with the user IN THE USER'S LANGUAGE. RULES: 1) NEVER ask about frame rate or resolution — default to 1920×1080 30 fps. Be maximally autonomous. Use 'questions_for_user' ONLY as a last resort (when the request is illogical or lacks artistic direction). Always propose the best solution as a suggestion so the user can approve without typing back. Asking questions PAUSES your process (no JSX will run this step). 2) Be extremely concise. 3) Provide a captivating short summary of completed work when is_task_complete is true. MANDATORY! Empty message + is_task_complete:true is FORBIDDEN.",
  "attach_files": [{"path": "D:/projects/test/image.png", "label": "Reference"}],
  "is_task_complete": false
}

Rules and Warnings:
1. Always produce valid JSON.
2. Parallel orchestration: assets in parallel_tasks run in the background BEFORE the "code" in this JSON executes in AE. So if you want to script BASED ON graphics or voiceover defined in parallel_tasks, leave \`code\` empty this step, set \`is_task_complete: false\`. Send the actual \`code\` in the NEXT iteration, after the assets have landed in app.project.item.
3. REMEMBER! If you generated images or TTS in an earlier step, they're ALREADY in the Project panel. In your code you MUST iterate \`app.project.items\`, find them (search by name containing 'aisist_gen_' or 'aisist_tts_'), and ADD them as layers via \`currentComp.layers.add(...)\`. Never ignore assets you created.
4. MANDATORY VISUAL VERIFICATION: when applying complex effects or arranging graphics, your second-to-last JSON should emit the generated code while still \`is_task_complete: false\`. In the next iteration you'll receive a real screenshot (Vision). Inspect it. Only when visually satisfied, return empty code with \`is_task_complete: true\`.
5. UNSAVED PROJECT: in After Effects \`app.project.file\` is very often \`null\` if the user hasn't saved the project. Any reference like \`app.project.file.parent\` will crash. DO NOT use \`app.project.file\`. All your assets are already in \`app.project.item\`.
6. OPENING A COMPOSITION: when you create a new comp (e.g. \`addComp\`), at the end of your script MANDATORILY call \`yourComp.openInViewer();\`. Otherwise the visual verification system (Vision) cannot capture its content.
7. UNDO GROUP (CRITICAL — read carefully):
   (a) The wrapper executing your code ALREADY calls \`app.beginUndoGroup("HEXART.PL/AfterALL Action")\` BEFORE your code and \`app.endUndoGroup()\` AFTER. Your code does NOT need (and SHOULD NOT) do this.
   (b) NEVER call \`app.beginUndoGroup(...)\` at the start of your script — it nests groups, forcing the user to press Ctrl+Z multiple times to undo a single step.
   (c) NEVER call \`app.endUndoGroup()\` in your code WITHOUT a preceding own \`beginUndoGroup\`. It closes the wrapper's group and subsequent operations land in an undefined group — breaking history cleanliness.
   (d) If you MUST logically split your step into sub-operations (rare!): wrap them in PAIRS of \`app.beginUndoGroup("Sub-action")\` + \`app.endUndoGroup()\`, ALWAYS inside a try/finally so endUndoGroup never gets skipped:
        try { app.beginUndoGroup("Subop"); /* ... */ } finally { app.endUndoGroup(); }
   (e) NEVER call \`app.executeCommand(16)\` (Undo), \`app.executeCommand(app.findMenuCommandId("Undo"))\`, or any Redo via executeCommand — it would undo the wrapper's group and leave AE inconsistent. The system handles wrapper Undo on error.
   (f) Default: one orchestration step = one Undo group in the user's view. Shorter atomic steps are BETTER — they give the user granular undo and readable history names.
   (g) If you see an "imbalanced UndoGroup" warning in lastError — your previous code either failed to close a group or opened one without closing. Fix immediately by removing manual begin/end calls.
8. DO NOT add \`alert()\` or \`confirm()\` calls when the script succeeds — they block the AE UI. Communicate via "message" in your JSON response.
9. MICRO-ORCHESTRATION: instead of writing one giant script that does everything, split execution into smaller logical stages using the agent loop (\`is_task_complete: false\`). Smaller steps mean errors only Undo that specific fragment, preserving correct earlier parts. Adjust step count to task progress.
10. LEARN FROM MEMORY: when a script "explodes" and the system returns error details (lastError), ALWAYS use \`update_memory\` in the next iteration to formulate a valuable rule for the future. Learn on the fly, permanently.
11. EXTENDSCRIPT CODE IN JSON (CRITICAL): always return code as an Array of Strings under the "code" key. NEVER use one big string with newlines (not even '\\n') — it repeatedly breaks the JSON parser. Each line of your code must be a separate array element. To minimize JSON-blow-up risk, your script MUST be broken into very short operations, returning is_task_complete: false and building the rest in the next signal.
12. UPDATE_MEMORY (optional): to add a rule to long-term memory, add the "update_memory" key as an array of objects: [{"action": "add", "content": "Rule content"}]. If you don't want to update memory this step, OMIT the key. DO NOT add it with an empty value.
13. SVG GENERATOR: in parallel_tasks use the "svg" key: ["prompt for SVG via the LLM"]. The agent generates an .svg file and imports it into AE.
14. IMAGE EDIT: in parallel_tasks use "edit_images": [{"prompt": "edit instruction e.g. remove bg, change color", "source": "last_image_0"}]. The agent edits an existing AI image and imports the result.
15. RENDER PREVIEW: use "render_preview": true (or an int e.g. 6) to capture frames from the timeline for animation evaluation. Frames arrive in the next vision context.
16. TASK COMPLETION (CRITICAL!!!): when ALL plan steps are finished: (a) set "is_task_complete": true, (b) write a short summary in "message" (e.g. "Done! Built composition X with 3 layers and a camera animation."). NO EXCEPTIONS! NEVER send an empty step (no code, no parallel_tasks) with is_task_complete:false — the system terminates IMMEDIATELY. ONE empty step = end. Common bug: forgetting is_task_complete when the plan says "Done" — CHECK before responding!
17. UNIQUE COMP NAMES: before \`addComp("name")\`, ALWAYS call \`getUniqueCompName("name")\` to avoid duplicates. Example: var compName = getUniqueCompName("Winter Documentary"); var comp = app.project.items.addComp(compName, 1920, 1080, 1, 30, 30);
18. IMPORT vs COMPOSITION: \`importAndAddToComp()\` does NOT create a new composition — it imports footage into the project (or adds to the active comp if one exists). Create compositions ONLY in your ExtendScript code when you're ready to edit.
19. TIMELINE EDIT (CRITICAL): voiceover (TTS) is the timeline axis. Editing algorithm: (1) Split the voiceover text into thematic segments (e.g. sentence about the forest, about birds, about the river). (2) Compute each segment's duration PROPORTIONAL to its character count (e.g. a 120-char segment of a 400-char total ≈ 30% of voiceover time). (3) Each segment may need MORE than 1 video clip! If a segment lasts 15s and a clip is 5s, use 2–3 clips or time-stretching (layer.stretch). (4) Place clips SEQUENTIALLY: clip1.startTime=0, clip2.startTime=clip1.outPoint, etc. (5) If a clip is too short — stretch it (layer.stretch) or repeat with a different frame. (6) GENERATE enough clips! Plan ~1 clip per 5–7s of narration. A 60s film = at least 8–12 video clips. (7) Voiceover on top, clips below, music at the bottom (-15dB). NEVER arrange randomly or leave empty gaps.
20. MUSIC UNDER VOICEOVER: music layer audioLevels at -15dB. Voiceover always on top (lower layer index).
21. FILM LENGTH: set comp.duration to the total length of voiceover/video at the end of editing.
22. VOICEOVER (TTS): generate ONE long voiceover instead of many short snippets! Concatenate the whole narration into one TTS prompt. Result: one long audio track, easier editing, no gaps. The system measures audio duration and auto-matches the music length.
23. MUSIC (LYRIA 3 PRO / ELEVEN MUSIC): active music provider = ${this.musicProvider}. For Lyria 3 Pro — the model auto-matches duration to timestamps in the prompt. For ElevenLabs Eleven Music you can pass duration_seconds (10–300s) and force_instrumental (true/false). The system auto-matches music length to TTS. ELEVEN MUSIC supports vocals — describe in your prompt whether you want vocals (e.g. "with female vocals, English lyrics about freedom") or pure instrumental.
24. ELEVEN MUSIC SYNTAX (when musicProvider=elevenlabs): parallel_tasks.music can be either a string (simple prompt) or an object: {"prompt": "epic orchestral cinematic", "duration_seconds": 60, "force_instrumental": true, "composition_plan": null}. For songs with vocals leave force_instrumental=false and describe the lyrics.
25. SFX (ELEVENLABS TEXT-TO-SOUND-EFFECTS): in parallel_tasks use the "sfx" key for short sound effects (0.5–22 s). Syntax: parallel_tasks.sfx: [{"prompt": "cinematic whoosh transition", "duration_seconds": 2, "prompt_influence": 0.4, "loop": false}]. KEY: prompt_influence 0–1 (default 0.3) — higher = more literal interpretation, lower = more model creativity. Loop=true creates a seamlessly loopable sound (ambient, rain). Ideal for: whooshes, impacts, ambient, risers, drones, foley, UI sounds, transitions, glitches, magic spells, atmospheres (rain, forest, city). DO NOT use SFX for long music tracks — use "music" for that.
26. IMAGE & VIDEO PROMPTS (CRITICAL): every image prompt MUST be at least 500 characters. Describe exactly WHAT is in the frame — narrate the scene like a film director. Include technical and artistic elements BUT vary them each time, unique, non-formulaic. DO NOT REPEAT the same patterns! Inspirations (not mandates): lens type, lighting style, depth of field, composition, contrast, color palette, mood, textures, in-frame motion, perspective, camera type, aberrations, film grain — MIX creatively, surprise, break conventions. Sometimes raw smartphone, sometimes perfect medium format. Important: each prompt must coherently describe ONE SPECIFIC frame — no vague generalities. Never make two identical prompts.
27. ASSET MANIFEST: after each generation step you'll receive a manifest with file list (name, type, prompt, duration). USE those names in your ExtendScript! Search the project by name from the manifest — don't guess.
28. VERSIONING (CRITICAL): when you edit an image (edit_images), the NEW version REPLACES the old. In timeline and animations ALWAYS use the LATEST version. The manifest marks them as "supersedes". If the user asked to fix an image, use the FIXED file in the composition, NOT the original!
29. SEARCHING PROJECT ASSETS: instead of reporting "file not found", search the project: for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i).name.indexOf("name_fragment")!==-1){...}}. Generated files have prefixes: aisist_img_, aisist_vid_, aisist_tts_, aisist_music_, aisist_edit_, aisist_svg_, aisist_sfx_.
30. VIDEO GROK + IMAGES (CRITICAL): when generating images and video in the same step, EVERY video_grok element MUST have "source": "last_image_N" pointing to the matching image! The system automatically waits for image generation, reads the file, and feeds it to Grok as a base frame (image-to-video). WITHOUT "source", Grok generates from scratch, ignoring your images! Example: {"prompt":"slow pan across snowy forest","source":"last_image_0","duration":5,"aspect_ratio":"16:9"}
31. IMAGE ORDERING: last_image_0 = first image in the images array, last_image_1 = second, etc. If images:["forest","bird","river","titmouse"] and video_grok has 4 items, sources should be last_image_0, last_image_1, last_image_2, last_image_3.
32. PRODUCTION ORDER (CRITICAL): plan steps in this order: STEP 1 — generate voiceover (TTS), ONE long. Music may join the same step (system auto-matches duration). STEP 2 — generate images matched to NARRATIVE SEGMENTS (each image illustrates a specific narration fragment). STEP 3 — bring images to life as video (Grok, with source: last_image_N). STEP 4 — assemble the timeline in AE (voiceover on top, clips proportional below, music underneath). DO NOT generate images in the same step as voiceover — you must KNOW the narration content first to choose proper frames.
33. VIDEO_GROK PROMPTS (CRITICAL): the video prompt DOES NOT REPEAT the scene description from the image! The image already DEFINES the visual scene. The video prompt describes ONLY: camera motion (slow pan left, dolly forward, gentle zoom in, static shot), dynamics (subtle motion, dramatic sweep), atmospheric effects (snow falling, fog drifting, wind in trees). GOOD example: "Slow cinematic dolly forward through the forest, subtle snow particles falling, gentle camera shake". BAD example: "A beautiful snowy forest with pine trees and a river" (that's already in the image!).
34. PYTHON ENVIRONMENTS: you have access to Python environments! In parallel_tasks use the "python" key: [{"env":"env_name","packages":["numpy","Pillow"],"git_repos":["https://github.com/user/repo"],"script":"import numpy; print(numpy.__version__)","command":"python -c 'test'"}]. The system auto-creates the venv, installs packages, clones repos, and runs the script. Environments are PERSISTENT — packages installed once are available in later steps. Use this for: advanced image processing, data generation, running AI/ML tools, automation with Python libraries.
35. PYTHON AUTONOMY (CRITICAL): you have full autonomy in creating Python scripts! (a) Write a script, (b) run it, (c) read stdout/stderr, (d) if errors — fix and run again. You may iterate many times. Find appropriate libraries (pip) for each task. Clone GitHub repos if needed.
36. PYTHON SKILLS: when you write a WORKING script, SAVE it as a skill by adding to parallel_tasks.python: "save_as_skill": {"name":"whisperx_transcribe","description":"Word-level audio transcription"}. The skill will appear in your palette and you can reuse it. At the start of each task review YOUR SKILLS context — you may already have the right tool!
37. PYTHON FULL PATHS (CRITICAL): in Python scripts ALWAYS use FULL file paths! The asset manifest provides full paths — use them. DO NOT use bare filenames because the Python script runs in the venv directory, not the project directory! Example: img = Image.open(r"D:/full/path/to/aisist_img_forest_174829.png") and NOT: img = Image.open("aisist_img_forest_174829.png").
38. LOCAL TOOLS AND SERVICES: if you need a local tool (ComfyUI, Stable Diffusion, an API server, a database, etc.) — USE PYTHON to discover, launch, and integrate it. Search the disk, check ports, start processes. SAVE the configuration into LTM (replace_category: "local_tools") and the ready script as a skill. Never assume something is installed — VERIFY FIRST. Ask the user if you can't find it.
39. BACKGROUND PROCESSES: you can start applications/services in the background! In parallel_tasks.python add: "background": true, "background_name": "comfyui", "background_cmd": "cd A:\\\\ComfyUI && python main.py", "ready_keyword": "listening on". The system: (a) starts the process detached, (b) watches stdout for ready_keyword, (c) returns status. If a process with that name already runs — DO NOT RESTART (dedup). Background process status is in === BACKGROUND PROCESSES === context. Use this for: ComfyUI, API servers, databases, etc.
40. ASK WHEN UNSURE: if you're unsure about file locations, user preferences, generation parameters, style, or tool choice — ASK using "questions_for_user". Better to ask than to guess and waste time. Particularly ask at the start of complex tasks (style, resolution, length, mood). But BALANCE — don't ask the obvious. If you're 80%+ confident, act.
41. SELF-ATTACHING FILES (attach_files): you can attach disk files into your context yourself! In your response add "attach_files": [{"path": "D:/full/path/to/file.png", "label": "Description"}]. Supported: images (png/jpg/webp), audio (mp3/wav), video (mp4/webm), text (txt/json/srt/jsx/py/csv). Binary files arrive as Vision in the next iteration. Text files are injected as text. USE THIS for: inspecting project assets, reading config files, checking renders, inspecting scripts. Paths must be FULL!
42. REFERENCE IMAGES IN GENERATION: when the user attaches images or you previously generated some, they're AUTOMATICALLY passed to the image model as references. The model sees them and can match style. Use this for: character sheets, style transfer, edits of existing images. DO NOT loop-generate the same thing — if an image doesn't meet expectations, ASK the user what to change instead of generating 10 times.
43. IMPORTING FILES INTO AE (CRITICAL): use SIMPLE ExtendScript for imports: var f = new ImportOptions(File("D:/path/to/file.json")); var item = app.project.importFile(f); NEVER build complex Python→file→AE bridges! If you need the project's footage folder path: var folder = app.project.file ? app.project.file.parent.fsName : "~/Desktop"; The path to a generated image is in the asset manifest you receive after parallel_tasks — use it directly in ImportOptions.
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

=== YOUR SAVED PYTHON SKILLS ===
${this.getSkillsSummary()}
=== END OF SKILLS ===
`;
    }

    // --- LTM Formatting (grouped by category, newest first) ---
    formatLTMForPrompt() {
        if (!this.longTermMemory || this.longTermMemory.length === 0) {
            return '(Empty memory — no rules saved yet)';
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
        let result = '\n=== BACKGROUND PROCESSES ===\n';
        names.forEach(name => {
            const p = this.backgroundProcesses[name];
            const uptime = Math.round((Date.now() - p.startedAt) / 1000);
            result += '[' + name + '] PID:' + p.pid + ' | Status:' + p.status + ' | Ready:' + (p.isReady ? 'TAK' : 'NIE') + ' | Uptime:' + uptime + 's\n';
            if (p.lastOutput) result += '  Last: ' + p.lastOutput.substring(0, 150) + '\n';
        });
        result += '=== END OF BACKGROUND PROCESSES ===\n';
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
        if (registry.skills.length === 0) return 'No Python skills saved yet.';
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

    // Project save state cache — checked by main.js pre-flight, also influences asset folder choice
    async getProjectSaveStatus() {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            csInterface.evalScript('getProjectSaveStatus()', (res) => {
                try { resolve(JSON.parse(res)); }
                catch (e) { resolve({ saved: false, modified: false, folder: '', file: '', name: '', error: 'parse' }); }
            });
        });
    }

    // Trigger AE Save / Save-As. forceDialog = true → always Save-As.
    async triggerProjectSave(forceDialog) {
        return new Promise((resolve) => {
            const csInterface = new CSInterface();
            const arg = forceDialog ? 'true' : 'false';
            csInterface.evalScript('saveProjectInteractive(' + arg + ')', (res) => {
                try { resolve(JSON.parse(res)); }
                catch (e) { resolve({ saved: false, cancelled: true, error: 'parse' }); }
            });
        });
    }

    // Returns a structured asset directory under <projectFolder>/aisist_assets/<kind>/
    // or — when the user explicitly opted to use temp folders — <os.tmpdir()>/hexart_afterall/<sessionId>/<kind>/.
    // kind: 'images' | 'audio' | 'video' | 'svg' | 'transcripts' | 'scripts' | 'temp'
    async getAssetDir(kind) {
        const fsNode = require('fs');
        const pathNode = require('path');
        const osNode = require('os');
        const validKind = ['images', 'audio', 'video', 'svg', 'transcripts', 'scripts', 'temp'].indexOf(kind) !== -1 ? kind : 'temp';

        // Path A: temp fallback (user explicitly opted in via useTempFolders)
        if (this.useTempFolders) {
            const sessionId = this._sessionId || 'session_' + Date.now();
            this._sessionId = sessionId;
            const base = pathNode.join(osNode.tmpdir(), 'hexart_afterall', sessionId, validKind);
            try { if (!fsNode.existsSync(base)) fsNode.mkdirSync(base, { recursive: true }); } catch (_) {}
            return base;
        }

        // Path B: project folder (preferred — when project is saved)
        try {
            const status = await this.getProjectSaveStatus();
            if (status && status.saved && status.folder) {
                const root = pathNode.join(status.folder, 'aisist_assets');
                const sub = pathNode.join(root, validKind);
                if (!fsNode.existsSync(sub)) fsNode.mkdirSync(sub, { recursive: true });
                return sub;
            }
        } catch (e) { /* fall through */ }

        // Path C: silent fallback (no project saved, no explicit opt-in yet — shouldn't normally happen
        // because pre-flight blocks this state, but keeps things robust if main.js is bypassed).
        const fallback = pathNode.join(osNode.tmpdir(), 'hexart_afterall_fallback', validKind);
        try { if (!fsNode.existsSync(fallback)) fsNode.mkdirSync(fallback, { recursive: true }); } catch (_) {}
        return fallback;
    }

    // Legacy alias — keeps backward compatibility with any code paths still calling the old name.
    // 'footage' was the historical flat directory; map it to 'temp' for new structured layout.
    async getProjectFootageDir() {
        return this.getAssetDir('temp');
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

                const tempDir = await this.getAssetDir('images');

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
                const tempDir = await this.getAssetDir('svg');
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

            const tempDir = await this.getAssetDir('images');
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

                const tempDir = await this.getAssetDir('video');
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
            const tempDir = await this.getAssetDir('audio');
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
                const tempDir = await this.getAssetDir('audio');
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

            const tempDir = await this.getAssetDir('audio');
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

            const tempDir = await this.getAssetDir('audio');
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
            // Persist transcription file in organized 'transcripts/' folder for re-use
            try {
                const transcriptDir = await this.getAssetDir('transcripts');
                const baseName = path.basename(audioPath).replace(/\.[^.]+$/, '_transcript.json');
                const outPath = path.join(transcriptDir, baseName);
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
            if (errorFeedback.startsWith("PARALLEL TASK RESULTS") || errorFeedback.startsWith("WYNIK ZADAŃ RÓWNOLEGŁYCH")) {
                messageText += `\n\n[SYSTEM]:\n${errorFeedback}`;
            } else {
                messageText += `\n\n[ERROR ALERT] The previously executed code threw an ExtendScript exception. Inspect and fix your script. Error details:\n${errorFeedback}`;
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
