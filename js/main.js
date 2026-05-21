let isAgentProcessing = false;
let userSuggestionQueue = [];

document.addEventListener('DOMContentLoaded', () => {

    // === Sound Notification System (Web Audio API) ===
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;
    let soundEnabled = true;
    
    // Load saved preference
    try {
        const savedPref = window.diskStorage.getItem('aisist_sound_enabled');
        if (savedPref !== null) soundEnabled = JSON.parse(savedPref);
    } catch(e) {}
    
    function getAudioCtx() {
        if (!audioCtx) audioCtx = new AudioCtx();
        return audioCtx;
    }
    
    function playTone(freq, duration, type, volume, detune) {
        if (!soundEnabled) return;
        try {
            const ctx = getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = type || 'sine';
            osc.frequency.value = freq;
            if (detune) osc.detune.value = detune;
            gain.gain.setValueAtTime(volume || 0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + duration);
        } catch(e) {}
    }
    
    function playChord(notes, duration, type, volume) {
        notes.forEach(n => playTone(n, duration, type, volume));
    }
    
    const sfx = {
        // Subtle click - new task started
        taskStart: () => {
            playTone(880, 0.12, 'sine', 0.06);
            setTimeout(() => playTone(1100, 0.1, 'sine', 0.05), 60);
        },
        // Soft blip - API response received
        apiResponse: () => {
            playTone(660, 0.08, 'sine', 0.04);
        },
        // Gentle rising - asset generated successfully
        assetReady: () => {
            playTone(523, 0.15, 'sine', 0.05);
            setTimeout(() => playTone(659, 0.15, 'sine', 0.04), 100);
        },
        // Warm chord - task completed
        taskComplete: () => {
            playTone(523, 0.4, 'sine', 0.07);
            setTimeout(() => playTone(659, 0.4, 'sine', 0.06), 120);
            setTimeout(() => playTone(784, 0.5, 'sine', 0.06), 240);
            setTimeout(() => playTone(1047, 0.6, 'sine', 0.05), 400);
        },
        // Low thud - error occurred
        error: () => {
            playTone(220, 0.2, 'triangle', 0.07);
            setTimeout(() => playTone(185, 0.25, 'triangle', 0.06), 100);
        },
        // Quick tick - code executed
        codeRun: () => {
            playTone(1200, 0.06, 'sine', 0.03);
        },
        // Soft whoosh - Python/skill running
        pythonRun: () => {
            playTone(400, 0.2, 'sine', 0.04);
            setTimeout(() => playTone(500, 0.15, 'sine', 0.03), 80);
        },
        // Gentle ping - image generated
        imageReady: () => {
            playTone(880, 0.1, 'sine', 0.05);
            setTimeout(() => playTone(1100, 0.12, 'sine', 0.04), 80);
        },
        // Warning beep
        warning: () => {
            playTone(440, 0.15, 'triangle', 0.05);
        }
    };





    // Wire sound toggle
    const soundToggle = document.getElementById('sound-toggle');
    if (soundToggle) {
        soundToggle.checked = soundEnabled;
        soundToggle.addEventListener('change', () => {
            soundEnabled = soundToggle.checked;
            window.diskStorage.setItem('aisist_sound_enabled', JSON.stringify(soundEnabled));
            if (soundEnabled) sfx.apiResponse(); // Play a test beep when enabled
        });
    }


    const agent = new AisistAgent();

    // ===== Orchestration subsystem ====================================
    const _O = window.AfterAllOrchestration || {};
    const assetTracker = _O.AssetTracker ? new _O.AssetTracker() : null;
    const permManager = _O.PermissionManager ? new _O.PermissionManager(window.diskStorage) : null;
    let currentPipeline = null; // active Pipeline instance
    if (assetTracker) agent._assetTracker = assetTracker;
    if (permManager) agent._permManager = permManager;

    // ===== MCP Bridge =================================================
    let mcpBridge = null;
    if (window.AfterAllMcpBridge) {
        const savedToken = window.diskStorage.getItem('hexart_mcp_token') || '';
        const savedPort = parseInt(window.diskStorage.getItem('hexart_mcp_port') || '7890', 10);
        const savedEnabled = window.diskStorage.getItem('hexart_mcp_enabled') === 'true';
        mcpBridge = new window.AfterAllMcpBridge({ port: savedPort, token: savedToken });
        registerMcpHandlers(mcpBridge);
        if (savedEnabled) {
            mcpBridge.start().catch(e => { /* log later when addLog ready */ });
        }
    }

    function registerMcpHandlers(bridge) {
        // status
        bridge.on('/status', async () => {
            const ctx = await agent.getDeepAEContext();
            return {
                ok: true,
                plugin: 'HEXART.PL/AfterALL',
                version: '2.1.0',
                bridge_port: bridge.port,
                llm_provider: agent.llmProvider,
                llm_model: agent.getActiveLLMModel(),
                project: { name: ctx.projectName || 'unknown', active_comp: ctx.activeComp || null, num_comps: (ctx.comps || []).length }
            };
        });
        bridge.on('/get_project_context', async () => agent.getDeepAEContext());
        bridge.on('/execute_extendscript', async (body) => {
            if (!body.code) throw new Error('Missing "code" field.');
            return await agent.runExtendScript(body.code);
        });
        bridge.on('/generate_image', async (body) => {
            if (!body.prompt) throw new Error('Missing "prompt".');
            return await agent.generateImageAndImport(body.prompt, (m) => bridge._log('info', m), 0);
        });
        bridge.on('/generate_tts', async (body) => {
            if (!body.text) throw new Error('Missing "text".');
            return await agent.generateSpeechAndImport(body.text, (m) => bridge._log('info', m));
        });
        bridge.on('/generate_music', async (body) => {
            if (!body.prompt) throw new Error('Missing "prompt".');
            return await agent.generateMusicAndImport(body, (m) => bridge._log('info', m));
        });
        bridge.on('/generate_sfx', async (body) => {
            if (!body.prompt) throw new Error('Missing "prompt".');
            return await agent.generateSFXAndImport(body, (m) => bridge._log('info', m));
        });
        bridge.on('/generate_video', async (body) => {
            if (!body.prompt) throw new Error('Missing "prompt".');
            return await agent.generateVideoAndImport({
                prompt: body.prompt,
                source: body.source_image || null,
                duration: body.duration || 5,
                aspect_ratio: body.aspect_ratio || '16:9'
            }, (m) => bridge._log('info', m));
        });
        bridge.on('/transcribe_audio', async (body) => {
            if (!body.source) throw new Error('Missing "source".');
            return await agent.transcribeAudio(body.source, (m) => bridge._log('info', m));
        });
        bridge.on('/run_python_task', async (body) => {
            return await agent.runPythonTask(body, (m) => bridge._log('info', m));
        });
        bridge.on('/get_screenshot', async () => {
            const snap = await agent.getAESnapshot();
            return snap ? { images: [{ data: snap.data, mimeType: snap.mimeType }] } : { error: 'No active composition.' };
        });
        bridge.on('/render_preview', async (body) => {
            return await agent.captureRenderPreview(parseInt(body.num_frames || 4, 10));
        });
        bridge.on('/capture_snapshot', async () => {
            if (!assetTracker) return { error: 'AssetTracker not loaded.' };
            const csi = new CSInterface();
            return await assetTracker.snapshotProject(csi);
        });
        bridge.on('/list_voices', async (body) => {
            const ELClient = window.AfterAllElevenLabs;
            if (!ELClient || !agent.elevenlabsApiKey) throw new Error('ElevenLabs not configured.');
            const client = new ELClient({ apiKey: agent.elevenlabsApiKey });
            if (body.source === 'user') return { voices: await client.listUserVoices(false) };
            return { voices: await client.searchVoiceLibrary({
                gender: body.gender, age: body.age, accent: body.accent, use_case: body.use_case, search: body.search, page_size: 100
            }) };
        });
        bridge.on('/list_skills', async () => {
            const md = (agent.skills || []).filter(s => s.type === 'markdown').map(s => ({ name: s.name, type: 'markdown', title: s.title }));
            const py = (agent.loadSkillsRegistry().skills || []).map(s => ({ name: s.name, type: 'python', env: s.env, packages: s.packages, description: s.description }));
            return { skills: md.concat(py) };
        });
        bridge.on('/list_tools_state', async () => ({ tools: agent.listAllTools() }));
        bridge.on('/set_feature_flag', async (body) => {
            if (!body.name) throw new Error('Missing "name".');
            agent.setFeatureFlag(body.name, !!body.enabled);
            return { ok: true, name: body.name, enabled: agent.isFeatureEnabled(body.name) };
        });
        bridge.on('/get_logs', async (body) => ({ logs: bridge.getLogs(parseInt(body.limit || 100, 10)) }));

        // The heavy one: full agent loop
        bridge.on('/send_prompt', async (body) => {
            if (!body.prompt) throw new Error('Missing "prompt".');
            // Run via UI to get all the benefits (pipeline, permissions, sessions)
            if (typeof window._mcpRunPrompt !== 'function') {
                throw new Error('Agent prompt handler not wired (UI not ready).');
            }
            return await window._mcpRunPrompt(body);
        });
        bridge.on('/get_task_status', async (body) => {
            if (!body.task_id) throw new Error('Missing "task_id".');
            const t = bridge.getTask(body.task_id);
            return t || { error: 'Unknown task_id.' };
        });
    }
    
    // UI Elements
    const chatContainer = document.getElementById('chat-container');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusIndicator = document.getElementById('status-indicator');
    const hexartLogoBtn = document.getElementById('hexart-logo-btn');

    if (hexartLogoBtn) {
        hexartLogoBtn.addEventListener('click', () => {
            const csInterface = new CSInterface();
            csInterface.openURLInDefaultBrowser("https://hexart.pl");
        });
    }

    // Buy Me a Coffee button - support Paul Lazniak
    const bmcBtn = document.getElementById('bmc-btn');
    if (bmcBtn) {
        bmcBtn.addEventListener('click', () => {
            try { new CSInterface().openURLInDefaultBrowser('https://buymeacoffee.com/eyb8tkx3to'); }
            catch (_) { window.open('https://buymeacoffee.com/eyb8tkx3to', '_blank'); }
        });
    }
    // Credit links — route through CSInterface so they open in default browser
    ['credit-yt-link', 'credit-hexart-link', 'credit-bmc-link'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => {
            e.preventDefault();
            try { new CSInterface().openURLInDefaultBrowser(el.getAttribute('href')); }
            catch (_) { window.open(el.getAttribute('href'), '_blank'); }
        });
    });

    // Zoom UI controls
    (function initZoom() {
        const ZOOM_STEP = 0.05;
        const ZOOM_MIN = 0.5;
        const ZOOM_MAX = 1.5;
        const ZOOM_KEY = 'aisist_ui_zoom';
        let currentZoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 1.0;
        document.body.style.zoom = currentZoom;

        const zoomIn = document.getElementById('zoom-in-btn');
        const zoomOut = document.getElementById('zoom-out-btn');
        if (zoomIn) zoomIn.addEventListener('click', () => {
            currentZoom = Math.min(ZOOM_MAX, +(currentZoom + ZOOM_STEP).toFixed(2));
            document.body.style.zoom = currentZoom;
            localStorage.setItem(ZOOM_KEY, currentZoom);
        });
        if (zoomOut) zoomOut.addEventListener('click', () => {
            currentZoom = Math.max(ZOOM_MIN, +(currentZoom - ZOOM_STEP).toFixed(2));
            document.body.style.zoom = currentZoom;
            localStorage.setItem(ZOOM_KEY, currentZoom);
        });
    })();
    
    // Log console
    const logConsoleToggle = document.getElementById('log-console-toggle');
    const logConsole = document.getElementById('log-console');
    const logMessages = document.getElementById('log-messages');
    const chevron = document.querySelector('.chevron');
    
    const settingsBtn = document.getElementById('settings-btn');
    const settingsOverlay = document.getElementById('settings-overlay');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    
    // Sesje UI
    const sessionsBtn = document.getElementById('sessions-btn');
    const closeSessionsBtn = document.getElementById('close-sessions-btn');
    const sessionsOverlay = document.getElementById('sessions-overlay');
    const sessionsList = document.getElementById('sessions-list');
    const newSessionBtn = document.getElementById('new-session-btn');
    
    let currentSessionId = Date.now().toString();
    
    const apiKeyInput = document.getElementById('api-key');
    const openrouterApiInput = document.getElementById('openrouter-api');
    const replicateApiInput = document.getElementById('replicate-api');
    const elevenlabsApiInput = document.getElementById('elevenlabs-api');
    const baseModelSelect = document.getElementById('basemodel-select');
    const imageModelSelect = document.getElementById('imagemodel-select');
    const ttsModelSelect = document.getElementById('ttsmodel-select');
    const ttsVoiceSelect = document.getElementById('ttsvoice-select');
    const uiLangSelect = document.getElementById('ui-lang-select');
    const projLangSelect = document.getElementById('proj-lang-select');
    // New: providers + sandbox
    const llmProviderSelect = document.getElementById('llm-provider-select');
    const imgProviderSelect = document.getElementById('image-provider-select');
    const openrouterLLMModelInput = document.getElementById('openrouter-llm-model');
    const openrouterGroundingModelInput = document.getElementById('openrouter-grounding-model');
    const openrouterImgModelInput = document.getElementById('openrouter-img-model');
    const lmstudioLLMModelSelect = document.getElementById('lmstudio-llm-model');
    const lmstudioBaseUrlInput = document.getElementById('lmstudio-base-url');
    const pythonSandboxPathInput = document.getElementById('python-sandbox-path');
    const toolsCachePathInput = document.getElementById('tools-cache-path');
    const sandboxCurrentPath = document.getElementById('sandbox-current-path');
    const sandboxCurrentEnvs = document.getElementById('sandbox-current-envs');

    const thinkingVideo = document.getElementById('thinking-video');
    const autoDebugCheck = document.getElementById('auto-debug');
    const visionContextCheck = document.getElementById('vision-context');
    const useGroundingCheck = document.getElementById('use-grounding');

// =====================================================================
// HEXART.PL/AfterALL — Full i18n dictionary
// =====================================================================
// Languages: pl (full) · en (full) · de · es · fr · ja
// Missing keys in non-PL/EN fall back to 'en'.
const i18nDict = {
    'pl': {
        // Header / status
        'greeting': 'HEXART.PL/AfterALL — agent gotowy do działania! ✨',
        'log-console-btn': 'Konsola Logów',
        'prompt-placeholder': 'Wpisz polecenie dla After Effects...',
        // Question form (with auto-apply timeout)
        'q-form-title': 'Oczekuję wytycznych',
        'q-form-intro': 'Możesz odpowiedzieć w formularzu poniżej LUB napisać odpowiedź bezpośrednio w czacie.',
        'q-form-suggestion-label': 'Sugestia',
        'q-form-suggestion-none': 'brak',
        'q-form-placeholder': 'Wpisz odpowiedź lub zostaw puste, aby użyć sugestii...',
        'q-form-submit': 'Zatwierdź',
        'q-form-submitted': 'Zatwierdzono',
        'q-form-chat-resolved': 'Odpowiedziano w czacie',
        'q-form-aborted': 'Przerwano...',
        'q-form-auto-applied': 'Auto-zatwierdzono sugestie',
        'q-form-countdown': 'Auto-zatwierdzenie za {n}s · kliknij dowolne pole, aby anulować',
        'q-form-countdown-cancelled': 'Auto-timer wyłączony',
        'q-form-no-answer-fallback': 'Zgadzam się z Twoją propozycją / brak uwag.',
        // Save-project pre-flight modal
        'save-project-title': 'Najpierw zapisz projekt',
        'save-project-intro': 'Twój projekt After Effects nie został jeszcze zapisany. Zapis teraz pozwoli agentowi umieścić wszystkie generowane zasoby (obrazy, audio, wideo, transkrypcje) w czytelnej, uporządkowanej strukturze obok pliku projektu — wszystko pozostaje przenośne i łatwe do backupu.',
        'save-project-structure-label': 'Po zapisie zasoby będą zorganizowane tak:',
        'save-project-skip-btn': '⊘ Kontynuuj bez zapisu',
        'save-project-save-btn': '💾 Zapisz projekt teraz',
        'save-project-consequences-title': '⚠ Kontynuując bez zapisu:',
        'save-project-cons-1': 'Wygenerowane zasoby trafią do folderu tymczasowego systemu — mogą zostać usunięte przy restarcie lub czyszczeniu dysku.',
        'save-project-cons-2': 'Ścieżki w projekcie będą absolutne, nie relatywne — przeniesienie/udostępnienie projektu zerwie linki.',
        'save-project-cons-3': 'Stracisz orientację które zasoby należą do tej kompozycji po wyczyszczeniu folderu tymczasowego.',
        'save-project-cons-4': 'Brak automatycznych backupów Twojej pracy.',
        'save-project-cons-final': 'Nadal chcesz kontynuować z folderami tymczasowymi?',
        'save-project-back-btn': '← Wróć',
        'save-project-confirm-skip-btn': 'Tak, użyj folderów tymczasowych',
        'save-project-save-anyway-btn': '💾 Jednak zapisuję',
        'save-project-saved-log': 'Projekt zapisany. Zasoby będą tworzone w aisist_assets/.',
        'save-project-using-temp-log': 'Pracuję w folderach tymczasowych — pamiętaj, mogą zostać usunięte.',
        'save-project-cancelled-log': 'Zadanie anulowane (projekt niezapisany).',
        'save-project-save-cancelled-log': 'Okno zapisu anulowane.',
        // Drag-to-AE assets
        'drag-to-ae-hint': 'Przeciągnij dokądkolwiek w After Effects (Project / Timeline / Composition)',
        'drag-label': 'PRZECIĄGNIJ',
        'asset-grid-header': 'Wygenerowano {n} zasobów — przeciągnij każdy z nich do dowolnego panelu After Effects.',
        // Live streaming thinking
        'thinking-live-label': 'Agent myśli — strumień LLM',
        'thinking-done-label': '⚙ Proces decyzyjny (streamowany — kliknij, by rozwinąć)',
        'plan-preview-label': 'Plan (w trakcie)',
        // ----- Status indicator -----
        'status-scanning-project': 'Skanuję projekt AE...',
        'status-fixing-error': 'Naprawiam błąd (próba {n}/{max})...',
        'status-task-interrupted': 'Zadanie przerwane.',
        'status-awaiting-response': 'Oczekuję na odpowiedź.',
        'status-task-error': 'Przerwano po błędzie.',
        'status-comm-error': 'Błąd komunikacji.',
        'status-aborted': 'Przerwano.',
        'status-aborting': 'Przerywam...',
        'status-json-recovery-aborted': 'Przerwano po błędzie JSON.',
        'status-task-completed-repetition': 'Zadanie zakończone (anty-pętla).',
        // ----- Save settings confirmation -----
        'settings-saved-toast': '✓ Ustawienia zaktualizowane. LLM: {llm} ({model}) · Obrazy: {img} · TTS: {tts}.',
        // ----- First-run hint -----
        'first-run-hint': '⚙ Otwórz Ustawienia (ikona koła zębatego) i skonfiguruj klucze API oraz wybierz dostawcę LLM.',
        // ----- Send / task lifecycle messages -----
        'amsg-no-api-key': '⚠ Nie wprowadzono klucza API. Kliknij ikonę zębatki, aby to naprawić.',
        'sysmsg-aborting-ops': '⚡ Przerywam bieżące operacje na żądanie użytkownika...',
        'sysmsg-prev-aborted-new-task': '⚡ Przerwano poprzednie zadanie. Rozpoczynam nowe.',
        'sysmsg-bridge-failed-start': '⚠ Bridge nie wystartował: {err} (zmień port i spróbuj ponownie)',
        'sysmsg-bridge-port-changed': '⚠ Port zmieniony — zatrzymaj i uruchom bridge ponownie, by zmiana zadziałała.',
        'sysmsg-el-no-permissions': '⚠ Twój klucz ElevenLabs nie ma uprawnienia <b>models_read</b>. Wygeneruj nowy klucz z permission "All" (zalecane) lub przynajmniej <b>models_read</b> i <b>voices_read</b>.',
        'sysmsg-el-key-needed': '⚠ Wprowadź klucz ElevenLabs w zakładce „Klucze API" przed otwarciem biblioteki głosów.',
        'sysmsg-delete-rejected': '⚠ Operacja usunięcia została odrzucona. Agent musi znaleźć alternatywę.',
        'sysmsg-task-cancelled': 'Zadanie zostało przerwane na Twoje życzenie. Co robimy dalej?',
        'sysmsg-json-recovery-failed': 'Wyczerpano próby odzyskania formatu JSON. Spróbuj ponownie z prostszym poleceniem.',
        'sysmsg-comm-error': '⚠ Wystąpił błąd komunikacji: {err}',
        // ----- Assistant fallback messages -----
        'amsg-task-done': 'Zadanie zakończone.',
        'amsg-doing-task': 'Realizuję zadanie...',
        'amsg-execution-result': 'Wynik działania: {res}',
        'amsg-code-error-fixing': 'Błąd w kodzie: {err}. Próbuję naprawić...',
        'amsg-code-error-stopped': 'Błąd w kodzie: {err}. Zatrzymano z powodu błędu.',
        'amsg-repetition-stop': 'Wygenerowano 4 obrazy z rzędu. Jeśli potrzebujesz dalszych zmian, napisz co poprawić.',
        // ----- Log messages -----
        'log-stop-signal-sent': 'Wysłano sygnał przerwania operacji...',
        'log-new-task': '--- Nowe zadanie ---',
        'log-prompt': 'Prompt: "{text}"',
        'log-user-interrupting': 'Użytkownik przerywa bieżący proces: "{text}"',
        'log-abort-sent': 'Abort wysłany — agent przerwie się przy najbliższej kontroli.',
        'log-soft-suggestion': 'Wiadomość w trakcie pracy (wstrzykuję do następnego kroku): "{text}"',
        'log-sending-script-context': 'Wysyłam zapytanie do środowiska ExtendScript o kontekst projektu...',
        'log-ae-context-received': 'Otrzymano kontekst projektu w {ms}ms. (Projekt aktywny: {active})',
        'log-protection-snapshot': 'Snapshot ochrony: {items} elementów / {comps} komp. (chronione przed agentem)',
        'log-changed-project': 'Zmiana projektu: {from} → {to}',
        'log-loaded-project-session': 'Wczytano ostatnią sesję projektu: {title}',
        'log-injected-queue': 'Wstrzyknięto {n} znaków z kolejki sugestii gracza!',
        'log-fetching-gemini-models': 'Pobieram listę modeli Gemini z API...',
        'log-fetching-lmstudio-models': 'Pobieram listę modeli z LM Studio...',
        'log-llm-call': 'Wywołanie LLM ({model})...',
        'log-llm-responded': 'LLM odpowiedział w {ms}ms (streamowane).',
        'log-task-completed-flag': 'Zadanie zakończone (is_task_complete: true).',
        'log-extendscript-call': 'Wywołuję kod ExtendScript w After Effects...',
        'log-extendscript-success': 'Skrypt wykonany pomyślnie w {ms}ms.',
        'log-extendscript-error': 'Błąd ExtendScript [Linia {line}]: {err}',
        'log-undo-success': 'Cofnięto zmiany z błędnego skryptu (Undo).',
        'log-undo-failed': 'Nie udało się cofnąć zmian (Undo).',
        'log-prep-self-repair': 'Przygotowanie do samo-naprawy (próba {n})...',
        'log-exhausted-retries': 'Wyczerpano próby naprawy ({max}). Pozostawiam zmiany w projekcie.',
        'log-process-cancelled-user': 'Proces pomyślnie anulowany przez użytkownika.',
        'log-app-exception': 'Wyjątek aplikacji: {err}',
        'log-json-format-err': 'Błąd formatu JSON od modelu. ({hint})',
        'log-self-repair-syntax': 'Samo-naprawa składni (próba {n})...',
        'log-detected-destructive': 'Wykryto {n} operacji destrukcyjnych — pytam o zgodę...',
        'log-skip-transient-file': 'Pomijam akceptację dla pliku tymczasowego: {target}',
        'log-user-denied-op': 'Użytkownik odmówił operacji: {op} na {target}',
        'log-loaded-session': 'Wczytano sesję z {date}',
        'log-deleted-session': 'Usunięto sesję z {date}',
        'log-new-session-created': 'Utworzono nową sesję.',
        'log-skill-not-found': 'Skill nie znaleziony: {name}',
        'log-skill-loaded': 'Agent załadował Skill: {name}',
        'log-skill-saved': 'Agent zapisał nowy Skill: {name}',
        'log-skill-deleted': 'Usunięto skill: {name}',
        'log-ltm-updated': 'Zaktualizowano Pamięć LTM ({n} operacji)',
        'log-ltm-rule-added': 'Ręcznie dodano regułę do LTM',
        'log-ltm-rule-deleted': 'Usunięto regułę LTM',
        'log-perm-rule-revoked': 'Cofnięto regułę uprawnień: {op} / {target}',
        'log-voice-pick-empty': 'Wybierz głos z listy',
        'log-voice-selected-as': 'Wybrano głos „{name}" jako {target}',
        'log-voice-added': 'Dodano głos „{name}" do biblioteki użytkownika.',
        'log-agent-resumes-prework': 'Agent zapowiedział pracę — kontynuuję.',
        'log-agent-continues-orchestration': 'Agent zdecydował o kontynuacji zadania (orkiestracja).',
        'log-modal-pause-required': 'Pauza wg żądania modelu (requires_user_input).',
        'log-skill-saved-as': 'Skill zapisany: {name} ({desc})',
        'log-saved-skill-toast': 'Zapisano nowy skill: {name}',
        // ----- Saved-skill chat output -----
        'sysmsg-skill-saved-toast': 'Zapisano nowy skill: <b>{name}</b>',
        // ----- Status: result returned by model -----
        'amsg-task-aborted-user': 'Zadanie zostało przerwane na Twoje życzenie. Co robimy dalej?',
        'status-ready': 'Gotowy',
        'status-thinking': 'Myślę...',
        'status-processing': 'Przetwarzam...',
        'status-done': 'Zadanie zakończone.',
        // Settings - tabs
        'settings-title': 'Ustawienia · HEXART.PL/AfterALL',
        'tab-general': 'Ogólne',
        'tab-providers': 'Dostawcy LLM',
        'tab-tts-stt': 'TTS / STT',
        'tab-features': 'Funkcje',
        'tab-paths': 'Ścieżki / Sandbox',
        'tab-secrets': 'Klucze API',
        // Settings - General
        'ui-lang-label': 'Język Interfejsu (UI)',
        'proj-lang-label': 'Język Komunikacji (Project Content)',
        'tts-voice-label': 'Głos Lektora (Gemini TTS)',
        'auto-debug-label': 'Automatyczna samo-naprawa (max 3 próby)',
        'vision-context-label': 'Wysyłaj zrzut ekranu kompozycji (Vision) w celu samoweryfikacji',
        'use-grounding-label': 'Włącz Google Search Grounding (dla Gemini)',
        // Settings - Providers
        'llm-section-title': '🤖 Główny Model (Logika / LLM)',
        'llm-provider-label': 'Dostawca LLM',
        'base-model-label': 'Model Gemini (Logika)',
        'gemini-hint': 'Lista pobierana z Google API · wymaga klucza Gemini',
        'openrouter-model-label': 'Model OpenRouter',
        'openrouter-hint': 'Wymaga klucza OpenRouter API · kliknij ikonę listy by przeglądać i filtrować',
        'openrouter-grounding-label': 'Model do wyszukiwania w sieci (Grounding)',
        'openrouter-grounding-hint': 'Używany tylko gdy „Google Search Grounding" jest włączony. Polecane: Perplexity Sonar Online · GPT-4o z web · DeepSeek z search.',
        'lmstudio-model-label': 'Model LM Studio',
        'lmstudio-url-label': 'URL serwera LM Studio',
        'lmstudio-hint': 'Lokalne modele · wymagany uruchomiony serwer LM Studio (Server Mode)',
        'img-section-title': '🎨 Generator Obrazów',
        'img-provider-label': 'Dostawca obrazów',
        'img-model-label': 'Model Obrazów (Gemini)',
        'or-image-model-label': 'Model obrazów OpenRouter',
        'tts-section-title': '🎙 Lektor (TTS) i Muzyka',
        'tts-model-label': 'Model TTS (Gemini)',
        'tts-music-hint': 'Modele TTS pobierane dynamicznie z Gemini API. Muzyka pozostaje w Gemini Lyria.',
        // Settings - TTS / STT
        'tts-card-title': '🎙 Generator Lektora (TTS)',
        'tts-provider-label': 'Dostawca TTS',
        'el-model-label': 'Model ElevenLabs',
        'el-output-format-label': 'Format wyjściowy',
        'el-voice-card-title': '👤 Głosy ElevenLabs',
        'el-voice-card-hint': 'Skonfiguruj domyślne głosy. Agent wybierze męski/żeński na podstawie prefiksu prompta TTS (np. „Male:" / „Female:").',
        'el-use-general-default': 'Używaj jednego głosu jako General Default (ignoruje płeć)',
        'el-default-voice-label': 'Głos domyślny (general)',
        'el-male-voice-label': 'Głos męski (domyślny)',
        'el-female-voice-label': 'Głos żeński (domyślny)',
        'voice-none': '— niewybrany —',
        'stt-card-title': '📝 Speech-to-Text (STT)',
        'stt-provider-label': 'Dostawca STT',
        'stt-model-label': 'Model Scribe',
        'stt-hint': 'Domyślnie Scribe v2 — lepsza dokładność i obsługa języków niż v1. WhisperX wymaga lokalnego Pythona.',
        'voice-stability': 'Stabilność',
        'voice-similarity': 'Podobieństwo',
        'voice-style': 'Styl',
        'voice-speaker-boost': 'Speaker Boost (lepsze podobieństwo do oryginału)',
        'voice-stability-hint': 'Wyższa wartość = bardziej powtarzalny, niższa = bardziej ekspresyjny.',
        'voice-style-hint': '0 = neutralnie, wyższe wartości = mocniejszy charakter (dla v2/v3 modeli).',
        // Settings - Features
        'features-card-title': '⚙ Aktywne funkcje',
        'features-card-hint': 'Wyłącz funkcje, których nie chcesz używać — agent zostanie poinformowany i nie będzie ich proponował.',
        'tools-card-title': '🧩 Aktywne narzędzia (Toolsy)',
        'tools-card-hint': 'Lista wszystkich narzędzi — również tych utworzonych automatycznie przez agenta. Możesz je dezaktywować.',
        'tools-no-custom': 'Brak dodatkowych narzędzi. Skille Python utworzone przez agenta pojawią się tutaj.',
        'open-tools-panel': 'Otwórz pełny panel narzędzi →',
        // Settings - Paths
        'sandbox-card-title': '📁 Sandbox środowisk Python',
        'sandbox-path-label': 'Folder dla środowisk Python (venv) i narzędzi',
        'sandbox-hint': 'Tu trafiają wszystkie venv, skille Python, repo gitowe, modele AI klonowane lokalnie. Wymagana przestrzeń: 10+ GB. Zostaw puste = domyślnie obok wtyczki.',
        'cache-path-label': 'Folder dla cache narzędzi / modeli (opcjonalnie)',
        'cache-hint': 'Opcjonalna lokalizacja dla pobranych modeli (Whisper, SDXL itp.). Jeśli puste — w podfolderze sandbox.',
        'sandbox-current': 'Aktualny stan:',
        // Settings - Secrets
        'api-key-label': 'Klucz API Gemini',
        'api-key-openrouter': 'Klucz OpenRouter API',
        'api-key-replicate': 'Klucz Replicate API (Grok Video)',
        'api-key-elevenlabs': 'Klucz ElevenLabs API (TTS/STT)',
        'custom-keys-label': 'Inne Custom API Keys',
        'custom-key-name-ph': 'Nazwa (np. OpenAI)',
        'custom-key-value-ph': 'Klucz API...',
        // Sessions / Memory / Skills
        'sessions-title': 'Historia Sesji',
        'new-session-btn': '+ Rozpocznij Nową Sesję',
        'memory-title': 'Mózg Agenta (LTM)',
        'skills-title': 'Skills',
        'new-skill-ph': 'Nazwa nowego skilla...',
        'new-skill-btn': 'Utwórz',
        'new-memory-ph': 'Nowa reguła ułatwiająca pracę...',
        'memory-add-btn': 'Dodaj',
        // Tools modal
        'tools-modal-title': 'Toolsy — Panel Narzędzi',
        'tools-filter-ph': '🔎 Filtruj...',
        'tools-refresh': '↻ Odśwież listę',
        'tools-select-prompt': 'Wybierz narzędzie z listy po lewej, aby zobaczyć ustawienia.',
        'tools-tab-overview': 'Przegląd',
        'tools-tab-settings': 'Ustawienia',
        'tools-tab-env': 'Środowisko',
        'tools-tab-runtime': 'Runtime',
        'tools-tab-docs': 'Dokumentacja',
        'tools-status-on': 'aktywny',
        'tools-status-off': 'wyłączony',
        'tools-group-generators': 'Generatory',
        'tools-group-integrations': 'Integracje',
        'tools-group-pyskills': 'Python Skille',
        'tools-group-background': 'Procesy w tle',
        'tools-group-other': 'Pozostałe',
        'tools-empty-filter': 'Brak narzędzi pasujących do filtra.',
        'tools-stats': '{total} narzędzi · {active} aktywnych',
        'tools-toggle-title': 'Aktywuj / Dezaktywuj',
        'tools-detail-overview': 'Przegląd',
        'tools-detail-settings': 'Ustawienia',
        'tools-detail-env': 'Środowisko',
        'tools-detail-runtime': 'Runtime',
        'tools-detail-row-name': 'Nazwa',
        'tools-detail-row-type': 'Typ',
        'tools-detail-row-state': 'Stan',
        'tools-detail-row-env': 'Środowisko venv',
        'tools-detail-row-packages': 'Pakiety',
        'tools-detail-row-created': 'Utworzono',
        'tools-detail-row-flag': 'Feature flag',
        'tools-detail-row-venv-folder': 'Folder venv',
        'tools-detail-stop-process': '⏹ Zatrzymaj proces',
        'tools-detail-stopped': 'Zatrzymano proces',
        'tools-settings-reset': '↺ Przywróć domyślne',
        'tools-settings-reset-confirm': 'Na pewno przywrócić ustawienia domyślne tego narzędzia?',
        'tools-settings-no-config': 'To narzędzie nie ma predefiniowanych ustawień. Możesz dodać własne pary klucz/wartość — agent zobaczy je w kontekście.',
        'tools-settings-section-custom': 'Własne parametry',
        'tools-settings-kv-label': 'Pary klucz/wartość',
        // Builtin tool labels & descriptions
        'tool-imageGen-label': 'Generator Obrazów',
        'tool-imageGen-desc': 'Generowanie obrazów (Gemini / OpenRouter)',
        'tool-imageEdit-label': 'Edytor Obrazów',
        'tool-imageEdit-desc': 'Edycja / inpainting istniejących obrazów',
        'tool-videoGen-label': 'Generator Wideo (Grok)',
        'tool-videoGen-desc': 'Wideo image-to-video przez Replicate Grok',
        'tool-ttsGen-label': 'Generator Lektora (TTS)',
        'tool-ttsGen-desc': 'Gemini TTS lub ElevenLabs TTS',
        'tool-sttGen-label': 'Transkrypcja (STT)',
        'tool-sttGen-desc': 'ElevenLabs Scribe / WhisperX word-level',
        'tool-musicGen-label': 'Generator Muzyki',
        'tool-musicGen-desc': 'Gemini Lyria 3 Pro lub ElevenLabs Music (z wokalami / instrumentalnie)',
        'tool-sfxGen-label': 'Efekty Dźwiękowe (SFX)',
        'tool-sfxGen-desc': 'ElevenLabs Text-to-SFX — odgłosy, dźwięki, ambient (0.5-22s)',
        'tool-svgGen-label': 'Generator SVG',
        'tool-svgGen-desc': 'Wektorowe grafiki SVG przez LLM',
        'tool-grounding-label': 'Google Search Grounding',
        'tool-grounding-desc': 'Live web access dla Gemini',
        'tool-renderPreview-label': 'Render Preview',
        'tool-renderPreview-desc': 'Multi-frame podgląd timeline dla Vision',
        'tool-pythonTools-label': 'Środowiska Python',
        'tool-pythonTools-desc': 'Tworzenie venv, instalacja pakietów, klonowanie repo',
        // Voice picker
        'voice-picker-title': 'Biblioteka Głosów ElevenLabs',
        'voice-picker-title-male': 'Wybierz głos męski (filtr „Male" aktywny)',
        'voice-picker-title-female': 'Wybierz głos żeński (filtr „Female" aktywny)',
        'voice-picker-title-default': 'Biblioteka Głosów ElevenLabs (general default)',
        'voice-picker-search-ph': '🔎 Szukaj po nazwie / opisie...',
        'voice-picker-source-library': 'Public Library (rozszerzona)',
        'voice-picker-source-user': 'Moje głosy (My Voices)',
        'voice-picker-gender-any': 'Płeć: dowolna',
        'voice-picker-age-any': 'Wiek: dowolny',
        'voice-picker-accent-any': 'Akcent: dowolny',
        'voice-picker-use-case-any': 'Zastosowanie: dowolne',
        'voice-picker-load': '↻ Pobierz / odśwież',
        'voice-picker-apply': 'Zastosuj wybrany głos',
        'voice-picker-preview': '▶ Preview',
        'voice-picker-add-to-my': '+ Dodaj do moich',
        'voice-picker-load-prompt': 'Naciśnij ↻ aby załadować głosy...',
        // OpenRouter picker
        'or-picker-title': 'Katalog modeli OpenRouter',
        'or-picker-search-ph': '🔎 Szukaj po nazwie / providerze...',
        'or-sort-price-asc': 'Cena ↑ (najtaniej)',
        'or-sort-price-desc': 'Cena ↓ (najdrożej)',
        'or-sort-name': 'Nazwa A–Z',
        'or-sort-context-desc': 'Kontekst ↓',
        'or-sort-new': 'Najnowsze',
        'or-filter-providers-all': 'Wszyscy dostawcy',
        'or-feat-image': 'Obsługa obrazów (Vision)',
        'or-feat-tools': 'Tool/Function calling',
        'or-feat-json': 'JSON mode',
        'or-feat-free': 'Tylko darmowe',
        'or-feat-imgout': 'Generuje obrazy',
        'or-reload': '↻ Pobierz ponownie',
        'or-apply': 'Zastosuj wybrany model',
        'or-pick-prompt': 'Wybierz katalog by załadować modele...',
        // Buttons / generic
        'save-btn': 'Zapisz',
        'cancel-btn': 'Anuluj',
        'close-btn': 'Zamknij',
        'apply-btn': 'Zastosuj',
        'browse-btn': 'Przeglądaj',
        'remove-btn': 'Usuń',
        // API help modal
        'api-help-title': 'Jak skonfigurować API?',
        'api-help-close-btn': 'Rozumiem',
        'api-help-steps-title': 'Krok po kroku',
        'api-help-pricing': 'Cennik / Free tier',
        'api-help-usage': 'Wykorzystywane do',
        'api-help-notes': 'Notatki',
        'api-help-troubleshoot': 'Najczęstsze problemy',
        'api-help-open-link': 'Otwórz w przeglądarce'
    },
    'en': {
        'greeting': 'HEXART.PL/AfterALL — agent ready! ✨',
        'log-console-btn': 'Log Console',
        'prompt-placeholder': 'Type command for After Effects...',
        // Question form (with auto-apply timeout)
        'q-form-title': 'Awaiting your guidance',
        'q-form-intro': 'Answer in the form below OR write a reply directly in the chat.',
        'q-form-suggestion-label': 'Suggestion',
        'q-form-suggestion-none': 'none',
        'q-form-placeholder': 'Type an answer or leave empty to use the suggestion...',
        'q-form-submit': 'Confirm',
        'q-form-submitted': 'Confirmed',
        'q-form-chat-resolved': 'Answered via chat',
        'q-form-aborted': 'Aborted...',
        'q-form-auto-applied': 'Auto-applied suggestions',
        'q-form-countdown': 'Auto-applying in {n}s · click any field to cancel',
        'q-form-countdown-cancelled': 'Auto-timer disabled',
        'q-form-no-answer-fallback': 'I agree with your suggestion / no further notes.',
        // Save-project pre-flight modal
        'save-project-title': 'Save your project first',
        'save-project-intro': 'Your After Effects project hasn\'t been saved yet. Saving now lets the agent place all generated assets (images, audio, video, transcripts) in a clean, organized folder next to your project file — keeping everything portable and easy to back up.',
        'save-project-structure-label': 'If you save, assets will be organized like this:',
        'save-project-skip-btn': '⊘ Continue without saving',
        'save-project-save-btn': '💾 Save project now',
        'save-project-consequences-title': '⚠ Continuing without saving means:',
        'save-project-cons-1': 'Generated assets land in your OS temp folder — they may be wiped on reboot or by system cleanup.',
        'save-project-cons-2': 'Asset paths in your project will be absolute system paths, not relative — moving or sharing the project later will break links.',
        'save-project-cons-3': 'You\'ll lose track of which assets belong to this composition once the temp folder is cleaned.',
        'save-project-cons-4': 'No automatic backups of your work.',
        'save-project-cons-final': 'Still want to continue with temporary folders?',
        'save-project-back-btn': '← Back',
        'save-project-confirm-skip-btn': 'Yes, use temp folders',
        'save-project-save-anyway-btn': '💾 Actually save',
        'save-project-saved-log': 'Project saved. Assets will land in aisist_assets/.',
        'save-project-using-temp-log': 'Working with temporary folders — remember they may be wiped.',
        'save-project-cancelled-log': 'Task cancelled (project unsaved).',
        'save-project-save-cancelled-log': 'Save dialog cancelled.',
        // Drag-to-AE assets
        'drag-to-ae-hint': 'Drag anywhere in After Effects (Project / Timeline / Composition)',
        'drag-label': 'DRAG',
        'asset-grid-header': 'Generated {n} assets — drag any of them into any After Effects panel.',
        // Live streaming thinking
        'thinking-live-label': 'Agent thinking — live LLM stream',
        'thinking-done-label': '⚙ Decision process (streamed — click to expand)',
        'plan-preview-label': 'Plan (in progress)',
        // ----- Status indicator -----
        'status-scanning-project': 'Scanning AE project...',
        'status-fixing-error': 'Fixing error (attempt {n}/{max})...',
        'status-task-interrupted': 'Task interrupted.',
        'status-awaiting-response': 'Awaiting your response.',
        'status-task-error': 'Stopped after error.',
        'status-comm-error': 'Communication error.',
        'status-aborted': 'Aborted.',
        'status-aborting': 'Aborting...',
        'status-json-recovery-aborted': 'Stopped after JSON error.',
        'status-task-completed-repetition': 'Task complete (anti-loop).',
        // ----- Save settings confirmation -----
        'settings-saved-toast': '✓ Settings updated. LLM: {llm} ({model}) · Images: {img} · TTS: {tts}.',
        // ----- First-run hint -----
        'first-run-hint': '⚙ Open Settings (gear icon) and configure your API keys + pick an LLM provider.',
        // ----- Send / task lifecycle messages -----
        'amsg-no-api-key': '⚠ No API key entered. Click the gear icon to fix this.',
        'sysmsg-aborting-ops': '⚡ Aborting current operations at your request...',
        'sysmsg-prev-aborted-new-task': '⚡ Previous task aborted. Starting a new one.',
        'sysmsg-bridge-failed-start': '⚠ Bridge failed to start: {err} (change the port and try again)',
        'sysmsg-bridge-port-changed': '⚠ Port changed — stop and restart the bridge for it to take effect.',
        'sysmsg-el-no-permissions': '⚠ Your ElevenLabs key is missing the <b>models_read</b> permission. Generate a new key with permission "All" (recommended) or at least <b>models_read</b> and <b>voices_read</b>.',
        'sysmsg-el-key-needed': '⚠ Enter your ElevenLabs key in the "API Keys" tab before opening the voice library.',
        'sysmsg-delete-rejected': '⚠ Deletion was rejected. The agent must find an alternative.',
        'sysmsg-task-cancelled': 'The task was interrupted at your request. What\'s next?',
        'sysmsg-json-recovery-failed': 'Exhausted attempts to recover JSON format. Try again with a simpler prompt.',
        'sysmsg-comm-error': '⚠ Communication error: {err}',
        // ----- Assistant fallback messages -----
        'amsg-task-done': 'Task complete.',
        'amsg-doing-task': 'Working on it...',
        'amsg-execution-result': 'Execution result: {res}',
        'amsg-code-error-fixing': 'Code error: {err}. Attempting repair...',
        'amsg-code-error-stopped': 'Code error: {err}. Stopped due to error.',
        'amsg-repetition-stop': 'Generated 4 images in a row. If you need further changes, tell me what to adjust.',
        // ----- Log messages -----
        'log-stop-signal-sent': 'Stop signal sent...',
        'log-new-task': '--- New task ---',
        'log-prompt': 'Prompt: "{text}"',
        'log-user-interrupting': 'User interrupts current process: "{text}"',
        'log-abort-sent': 'Abort dispatched — agent will halt at next checkpoint.',
        'log-soft-suggestion': 'Mid-work message (injecting into next step): "{text}"',
        'log-sending-script-context': 'Requesting project context from ExtendScript...',
        'log-ae-context-received': 'Received project context in {ms}ms. (Active project: {active})',
        'log-protection-snapshot': 'Protection snapshot: {items} items / {comps} comps (protected from the agent)',
        'log-changed-project': 'Project changed: {from} → {to}',
        'log-loaded-project-session': 'Loaded last session for this project: {title}',
        'log-injected-queue': 'Injected {n} characters from user suggestion queue!',
        'log-fetching-gemini-models': 'Fetching Gemini model list from API...',
        'log-fetching-lmstudio-models': 'Fetching LM Studio model list...',
        'log-llm-call': 'Calling LLM ({model})...',
        'log-llm-responded': 'LLM responded in {ms}ms (streamed).',
        'log-task-completed-flag': 'Task complete (is_task_complete: true).',
        'log-extendscript-call': 'Calling ExtendScript in After Effects...',
        'log-extendscript-success': 'Script executed successfully in {ms}ms.',
        'log-extendscript-error': 'ExtendScript error [Line {line}]: {err}',
        'log-undo-success': 'Rolled back changes from failed script (Undo).',
        'log-undo-failed': 'Failed to undo changes.',
        'log-prep-self-repair': 'Preparing self-repair (attempt {n})...',
        'log-exhausted-retries': 'Exhausted repair attempts ({max}). Leaving changes in the project.',
        'log-process-cancelled-user': 'Process successfully cancelled by user.',
        'log-app-exception': 'Application exception: {err}',
        'log-json-format-err': 'JSON format error from model. ({hint})',
        'log-self-repair-syntax': 'Self-repairing syntax (attempt {n})...',
        'log-detected-destructive': 'Detected {n} destructive operations — asking for consent...',
        'log-skip-transient-file': 'Skipping consent for transient file: {target}',
        'log-user-denied-op': 'User denied operation: {op} on {target}',
        'log-loaded-session': 'Loaded session from {date}',
        'log-deleted-session': 'Deleted session from {date}',
        'log-new-session-created': 'New session created.',
        'log-skill-not-found': 'Skill not found: {name}',
        'log-skill-loaded': 'Agent loaded skill: {name}',
        'log-skill-saved': 'Agent saved new skill: {name}',
        'log-skill-deleted': 'Deleted skill: {name}',
        'log-ltm-updated': 'LTM memory updated ({n} operations)',
        'log-ltm-rule-added': 'Manually added LTM rule',
        'log-ltm-rule-deleted': 'Deleted LTM rule',
        'log-perm-rule-revoked': 'Revoked permission rule: {op} / {target}',
        'log-voice-pick-empty': 'Pick a voice from the list',
        'log-voice-selected-as': 'Selected voice "{name}" as {target}',
        'log-voice-added': 'Added voice "{name}" to your library.',
        'log-agent-resumes-prework': 'Agent announced work — continuing.',
        'log-agent-continues-orchestration': 'Agent decided to continue (orchestration).',
        'log-modal-pause-required': 'Paused by model request (requires_user_input).',
        'log-skill-saved-as': 'Skill saved: {name} ({desc})',
        'log-saved-skill-toast': 'Saved new skill: {name}',
        // ----- Saved-skill chat output -----
        'sysmsg-skill-saved-toast': 'Saved new skill: <b>{name}</b>',
        // ----- Status: result returned by model -----
        'amsg-task-aborted-user': 'The task was interrupted at your request. What\'s next?',
        'status-ready': 'Ready', 'status-thinking': 'Thinking...', 'status-processing': 'Processing...', 'status-done': 'Task complete.',
        'settings-title': 'Settings · HEXART.PL/AfterALL',
        'tab-general': 'General', 'tab-providers': 'LLM Providers', 'tab-tts-stt': 'TTS / STT', 'tab-features': 'Features', 'tab-paths': 'Paths / Sandbox', 'tab-secrets': 'API Keys',
        'ui-lang-label': 'UI Language', 'proj-lang-label': 'Project Content Language',
        'tts-voice-label': 'Voice (Gemini TTS)',
        'auto-debug-label': 'Auto-debugging (max 3 retries)',
        'vision-context-label': 'Send composition screenshot (Vision) for self-verification',
        'use-grounding-label': 'Enable Google Search Grounding (Gemini only)',
        'llm-section-title': '🤖 Main Model (Logic / LLM)',
        'llm-provider-label': 'LLM Provider',
        'base-model-label': 'Gemini Model (Logic)',
        'gemini-hint': 'List fetched from Google API · requires Gemini key',
        'openrouter-model-label': 'OpenRouter Model',
        'openrouter-hint': 'Requires OpenRouter API key · click the list icon to browse and filter',
        'openrouter-grounding-label': 'Web-search model (Grounding)',
        'openrouter-grounding-hint': 'Used only when "Google Search Grounding" is enabled. Recommended: Perplexity Sonar Online · GPT-4o with web · DeepSeek with search.',
        'lmstudio-model-label': 'LM Studio Model',
        'lmstudio-url-label': 'LM Studio Server URL',
        'lmstudio-hint': 'Local models · requires LM Studio Server Mode running',
        'img-section-title': '🎨 Image Generator',
        'img-provider-label': 'Image Provider',
        'img-model-label': 'Image Model (Gemini)',
        'or-image-model-label': 'OpenRouter Image Model',
        'tts-section-title': '🎙 TTS and Music',
        'tts-model-label': 'TTS Model (Gemini)',
        'tts-music-hint': 'TTS models loaded dynamically from Gemini API. Music stays on Gemini Lyria.',
        'tts-card-title': '🎙 Voice Generator (TTS)',
        'tts-provider-label': 'TTS Provider',
        'el-model-label': 'ElevenLabs Model',
        'el-output-format-label': 'Output Format',
        'el-voice-card-title': '👤 ElevenLabs Voices',
        'el-voice-card-hint': 'Configure default voices. The agent picks male/female based on TTS prompt prefix (e.g. "Male:" / "Female:").',
        'el-use-general-default': 'Use one voice as General Default (ignore gender)',
        'el-default-voice-label': 'Default voice (general)',
        'el-male-voice-label': 'Default male voice',
        'el-female-voice-label': 'Default female voice',
        'voice-none': '— none —',
        'stt-card-title': '📝 Speech-to-Text (STT)',
        'stt-provider-label': 'STT Provider',
        'stt-model-label': 'Scribe Model',
        'stt-hint': 'Defaults to Scribe v2 — better accuracy and language support than v1. WhisperX requires local Python.',
        'voice-stability': 'Stability', 'voice-similarity': 'Similarity', 'voice-style': 'Style',
        'voice-speaker-boost': 'Speaker Boost (better similarity to source)',
        'voice-stability-hint': 'Higher = more consistent, lower = more expressive.',
        'voice-style-hint': '0 = neutral, higher = stronger character (v2/v3 models).',
        'features-card-title': '⚙ Active Features',
        'features-card-hint': 'Disable features you don\'t need — the agent will be informed and won\'t propose them.',
        'tools-card-title': '🧩 Active Tools',
        'tools-card-hint': 'List of all tools — including those created automatically by the agent. Toggle them off here.',
        'tools-no-custom': 'No additional tools. Python skills created by the agent will appear here.',
        'open-tools-panel': 'Open full tools panel →',
        'sandbox-card-title': '📁 Python Sandbox',
        'sandbox-path-label': 'Folder for Python venvs and tools',
        'sandbox-hint': 'All venvs, Python skills, git repos, locally-cloned AI models go here. Required space: 10+ GB. Leave empty for default (next to extension).',
        'cache-path-label': 'Tools / models cache folder (optional)',
        'cache-hint': 'Optional location for downloaded models (Whisper, SDXL, etc.). Empty = subfolder of sandbox.',
        'sandbox-current': 'Current state:',
        'api-key-label': 'Gemini API Key',
        'api-key-openrouter': 'OpenRouter API Key',
        'api-key-replicate': 'Replicate API Key (Grok Video)',
        'api-key-elevenlabs': 'ElevenLabs API Key (TTS/STT)',
        'custom-keys-label': 'Other Custom API Keys',
        'custom-key-name-ph': 'Name (e.g. OpenAI)',
        'custom-key-value-ph': 'API Key...',
        'sessions-title': 'Session History',
        'new-session-btn': '+ Start New Session',
        'memory-title': 'Agent Brain (LTM)',
        'skills-title': 'Skills',
        'new-skill-ph': 'New skill name...',
        'new-skill-btn': 'Create',
        'new-memory-ph': 'New rule to help with work...',
        'memory-add-btn': 'Add',
        'tools-modal-title': 'Tools — Toolkit Panel',
        'tools-filter-ph': '🔎 Filter...',
        'tools-refresh': '↻ Refresh',
        'tools-select-prompt': 'Pick a tool from the list to see its settings.',
        'tools-tab-overview': 'Overview',
        'tools-tab-settings': 'Settings',
        'tools-tab-env': 'Environment',
        'tools-tab-runtime': 'Runtime',
        'tools-tab-docs': 'Documentation',
        'tools-status-on': 'active', 'tools-status-off': 'disabled',
        'tools-group-generators': 'Generators',
        'tools-group-integrations': 'Integrations',
        'tools-group-pyskills': 'Python Skills',
        'tools-group-background': 'Background processes',
        'tools-group-other': 'Other',
        'tools-empty-filter': 'No tools match the filter.',
        'tools-stats': '{total} tools · {active} active',
        'tools-toggle-title': 'Enable / Disable',
        'tools-detail-overview': 'Overview',
        'tools-detail-settings': 'Settings',
        'tools-detail-env': 'Environment',
        'tools-detail-runtime': 'Runtime',
        'tools-detail-row-name': 'Name',
        'tools-detail-row-type': 'Type',
        'tools-detail-row-state': 'State',
        'tools-detail-row-env': 'venv environment',
        'tools-detail-row-packages': 'Packages',
        'tools-detail-row-created': 'Created',
        'tools-detail-row-flag': 'Feature flag',
        'tools-detail-row-venv-folder': 'venv folder',
        'tools-detail-stop-process': '⏹ Stop process',
        'tools-detail-stopped': 'Process stopped',
        'tools-settings-reset': '↺ Reset to defaults',
        'tools-settings-reset-confirm': 'Reset this tool\'s settings to defaults?',
        'tools-settings-no-config': 'This tool has no predefined settings. You can add your own key/value pairs — the agent will see them in context.',
        'tools-settings-section-custom': 'Custom parameters',
        'tools-settings-kv-label': 'Key/value pairs',
        // Builtin tool labels & descriptions
        'tool-imageGen-label': 'Image Generator',
        'tool-imageGen-desc': 'Generate images (Gemini / OpenRouter)',
        'tool-imageEdit-label': 'Image Editor',
        'tool-imageEdit-desc': 'Edit / inpainting on existing images',
        'tool-videoGen-label': 'Video Generator (Grok)',
        'tool-videoGen-desc': 'Image-to-video via Replicate Grok',
        'tool-ttsGen-label': 'Voice Generator (TTS)',
        'tool-ttsGen-desc': 'Gemini TTS or ElevenLabs TTS',
        'tool-sttGen-label': 'Transcription (STT)',
        'tool-sttGen-desc': 'ElevenLabs Scribe / WhisperX word-level',
        'tool-musicGen-label': 'Music Generator',
        'tool-musicGen-desc': 'Gemini Lyria 3 Pro or ElevenLabs Music (vocals / instrumental)',
        'tool-sfxGen-label': 'Sound Effects (SFX)',
        'tool-sfxGen-desc': 'ElevenLabs Text-to-SFX — sounds, ambient (0.5-22s)',
        'tool-svgGen-label': 'SVG Generator',
        'tool-svgGen-desc': 'Vector SVG graphics via LLM',
        'tool-grounding-label': 'Google Search Grounding',
        'tool-grounding-desc': 'Live web access for Gemini',
        'tool-renderPreview-label': 'Render Preview',
        'tool-renderPreview-desc': 'Multi-frame timeline preview for Vision',
        'tool-pythonTools-label': 'Python Environments',
        'tool-pythonTools-desc': 'venv + pip + git clone + custom scripts',
        'voice-picker-title': 'ElevenLabs Voice Library',
        'voice-picker-title-male': 'Pick a male voice (Male filter locked)',
        'voice-picker-title-female': 'Pick a female voice (Female filter locked)',
        'voice-picker-title-default': 'ElevenLabs Voice Library (general default)',
        'voice-picker-search-ph': '🔎 Search by name / description...',
        'voice-picker-source-library': 'Public Library (extended)',
        'voice-picker-source-user': 'My Voices',
        'voice-picker-gender-any': 'Gender: any',
        'voice-picker-age-any': 'Age: any',
        'voice-picker-accent-any': 'Accent: any',
        'voice-picker-use-case-any': 'Use case: any',
        'voice-picker-load': '↻ Load / refresh',
        'voice-picker-apply': 'Apply selected voice',
        'voice-picker-preview': '▶ Preview',
        'voice-picker-add-to-my': '+ Add to my voices',
        'voice-picker-load-prompt': 'Press ↻ to load voices...',
        'or-picker-title': 'OpenRouter Model Catalog',
        'or-picker-search-ph': '🔎 Search by name / provider...',
        'or-sort-price-asc': 'Price ↑ (cheapest)',
        'or-sort-price-desc': 'Price ↓ (most expensive)',
        'or-sort-name': 'Name A–Z',
        'or-sort-context-desc': 'Context ↓',
        'or-sort-new': 'Newest',
        'or-filter-providers-all': 'All providers',
        'or-feat-image': 'Image support (Vision)',
        'or-feat-tools': 'Tool/Function calling',
        'or-feat-json': 'JSON mode',
        'or-feat-free': 'Free only',
        'or-feat-imgout': 'Generates images',
        'or-reload': '↻ Reload',
        'or-apply': 'Apply selected model',
        'or-pick-prompt': 'Choose catalog to load models...',
        'save-btn': 'Save', 'cancel-btn': 'Cancel', 'close-btn': 'Close', 'apply-btn': 'Apply', 'browse-btn': 'Browse', 'remove-btn': 'Remove',
        'api-help-title': 'How to set up the API?',
        'api-help-close-btn': 'Got it',
        'api-help-steps-title': 'Step by step',
        'api-help-pricing': 'Pricing / Free tier',
        'api-help-usage': 'Used for',
        'api-help-notes': 'Notes',
        'api-help-troubleshoot': 'Common issues',
        'api-help-open-link': 'Open in browser'
    },
    'de': {
        'greeting': 'HEXART.PL/AfterALL — Agent bereit! ✨',
        'log-console-btn': 'Log-Konsole',
        'prompt-placeholder': 'Befehl für After Effects eingeben...',
        'status-ready': 'Bereit', 'status-thinking': 'Denke nach...', 'status-processing': 'Verarbeite...', 'status-done': 'Aufgabe erledigt.',
        'settings-title': 'Einstellungen · HEXART.PL/AfterALL',
        'tab-general': 'Allgemein', 'tab-providers': 'LLM-Anbieter', 'tab-tts-stt': 'TTS / STT', 'tab-features': 'Funktionen', 'tab-paths': 'Pfade / Sandbox', 'tab-secrets': 'API-Schlüssel',
        'ui-lang-label': 'UI-Sprache', 'proj-lang-label': 'Projektinhalt-Sprache',
        'tts-voice-label': 'Stimme (Gemini TTS)',
        'auto-debug-label': 'Automatische Selbstreparatur (max. 3 Versuche)',
        'vision-context-label': 'Komp-Screenshot (Vision) zur Selbstprüfung senden',
        'use-grounding-label': 'Google Search Grounding aktivieren (nur Gemini)',
        'llm-section-title': '🤖 Hauptmodell (Logik / LLM)',
        'llm-provider-label': 'LLM-Anbieter',
        'base-model-label': 'Gemini-Modell (Logik)',
        'gemini-hint': 'Liste wird von Google-API geladen · Gemini-Schlüssel erforderlich',
        'openrouter-model-label': 'OpenRouter-Modell',
        'lmstudio-model-label': 'LM Studio Modell',
        'lmstudio-url-label': 'LM Studio Server-URL',
        'img-section-title': '🎨 Bildgenerator',
        'tts-card-title': '🎙 Sprachgenerator (TTS)',
        'el-voice-card-title': '👤 ElevenLabs-Stimmen',
        'stt-card-title': '📝 Speech-to-Text (STT)',
        'features-card-title': '⚙ Aktive Funktionen',
        'tools-card-title': '🧩 Aktive Werkzeuge',
        'sandbox-card-title': '📁 Python-Sandbox',
        'api-key-label': 'Gemini-API-Schlüssel',
        'api-key-openrouter': 'OpenRouter-API-Schlüssel',
        'api-key-replicate': 'Replicate-API-Schlüssel',
        'api-key-elevenlabs': 'ElevenLabs-API-Schlüssel',
        'save-btn': 'Speichern', 'cancel-btn': 'Abbrechen', 'close-btn': 'Schließen', 'apply-btn': 'Anwenden',
        'api-help-title': 'Wie richte ich die API ein?',
        'api-help-close-btn': 'Verstanden',
        'api-help-steps-title': 'Schritt für Schritt',
        'api-help-pricing': 'Preise / Kostenlose Stufe',
        'api-help-usage': 'Verwendet für',
        'api-help-notes': 'Hinweise',
        'api-help-troubleshoot': 'Häufige Probleme',
        'sessions-title': 'Sitzungsverlauf', 'new-session-btn': '+ Neue Sitzung',
        // Tools modal
        'tools-modal-title': 'Werkzeuge — Toolkit-Panel',
        'tools-filter-ph': '🔎 Filter...',
        'tools-refresh': '↻ Aktualisieren',
        'tools-select-prompt': 'Wähle ein Werkzeug aus der Liste links aus.',
        'tools-status-on': 'aktiv', 'tools-status-off': 'deaktiviert',
        'tools-group-generators': 'Generatoren',
        'tools-group-integrations': 'Integrationen',
        'tools-group-pyskills': 'Python-Skills',
        'tools-group-background': 'Hintergrundprozesse',
        'tools-group-other': 'Sonstige',
        'tools-empty-filter': 'Keine Werkzeuge passen zum Filter.',
        'tools-stats': '{total} Werkzeuge · {active} aktiv',
        'tools-toggle-title': 'Aktivieren / Deaktivieren',
        'tools-detail-overview': 'Übersicht',
        'tools-detail-settings': 'Einstellungen',
        'tools-detail-env': 'Umgebung',
        'tools-detail-runtime': 'Laufzeit',
        'tools-detail-row-name': 'Name',
        'tools-detail-row-type': 'Typ',
        'tools-detail-row-state': 'Status',
        'tools-detail-row-env': 'venv-Umgebung',
        'tools-detail-row-packages': 'Pakete',
        'tools-detail-row-created': 'Erstellt',
        'tools-detail-row-flag': 'Feature-Flag',
        'tools-detail-row-venv-folder': 'venv-Ordner',
        'tools-detail-stop-process': '⏹ Prozess stoppen',
        'tools-settings-reset': '↺ Auf Standard zurücksetzen',
        'tools-settings-reset-confirm': 'Einstellungen dieses Werkzeugs auf Standardwerte zurücksetzen?',
        'tools-settings-no-config': 'Dieses Werkzeug hat keine vordefinierten Einstellungen. Du kannst eigene Schlüssel/Wert-Paare hinzufügen.',
        'q-form-title': 'Warte auf deine Anweisungen',
        'q-form-intro': 'Antworte im Formular unten ODER schreibe direkt in den Chat.',
        'q-form-suggestion-label': 'Vorschlag',
        'q-form-suggestion-none': 'keiner',
        'q-form-placeholder': 'Antwort eingeben oder leer lassen, um den Vorschlag zu verwenden...',
        'q-form-submit': 'Bestätigen',
        'q-form-submitted': 'Bestätigt',
        'q-form-chat-resolved': 'Per Chat beantwortet',
        'q-form-aborted': 'Abgebrochen...',
        'q-form-auto-applied': 'Vorschläge auto-übernommen',
        'q-form-countdown': 'Auto-Übernahme in {n}s · klicke ein Feld zum Abbrechen',
        'q-form-countdown-cancelled': 'Auto-Timer deaktiviert',
        'q-form-no-answer-fallback': 'Ich stimme deinem Vorschlag zu / keine Anmerkungen.',
        'drag-to-ae-hint': 'Ziehe das Asset an einen beliebigen Ort in After Effects (Projekt / Timeline / Komposition)',
        'drag-label': 'ZIEHEN',
        'asset-grid-header': '{n} Assets generiert — ziehe jedes davon in ein beliebiges After-Effects-Panel.',
        'status-scanning-project': 'AE-Projekt wird gescannt...',
        'status-fixing-error': 'Fehler wird behoben (Versuch {n}/{max})...',
        'status-task-interrupted': 'Aufgabe unterbrochen.',
        'status-awaiting-response': 'Warte auf deine Antwort.',
        'status-task-error': 'Nach Fehler gestoppt.',
        'status-comm-error': 'Kommunikationsfehler.',
        'status-aborted': 'Abgebrochen.',
        'status-aborting': 'Wird abgebrochen...',
        'status-json-recovery-aborted': 'Nach JSON-Fehler gestoppt.',
        'status-task-completed-repetition': 'Aufgabe erledigt (Anti-Schleife).',
        'settings-saved-toast': '✓ Einstellungen aktualisiert. LLM: {llm} ({model}) · Bilder: {img} · TTS: {tts}.',
        'first-run-hint': '⚙ Öffne Einstellungen (Zahnrad) und konfiguriere API-Schlüssel + wähle LLM-Anbieter.',
        'amsg-no-api-key': '⚠ Kein API-Schlüssel eingegeben. Klicke das Zahnrad, um das zu beheben.',
        'sysmsg-aborting-ops': '⚡ Operationen werden auf Wunsch abgebrochen...',
        'sysmsg-prev-aborted-new-task': '⚡ Vorherige Aufgabe abgebrochen. Neue beginnt.',
        'sysmsg-task-cancelled': 'Die Aufgabe wurde auf deinen Wunsch unterbrochen. Wie weiter?',
        'sysmsg-comm-error': '⚠ Kommunikationsfehler: {err}',
        'amsg-task-done': 'Aufgabe erledigt.',
        'amsg-doing-task': 'Arbeite daran...',
        'amsg-execution-result': 'Ausführungsergebnis: {res}',
        'amsg-code-error-fixing': 'Code-Fehler: {err}. Reparatur läuft...',
        'amsg-code-error-stopped': 'Code-Fehler: {err}. Wegen Fehler gestoppt.',
        'log-new-task': '--- Neue Aufgabe ---',
        'log-prompt': 'Prompt: "{text}"',
        'log-llm-call': 'LLM-Aufruf ({model})...',
        'log-llm-responded': 'LLM antwortete in {ms}ms (gestreamt).',
        'log-extendscript-call': 'Rufe ExtendScript in After Effects auf...',
        'log-extendscript-success': 'Skript erfolgreich ausgeführt in {ms}ms.',
        'log-extendscript-error': 'ExtendScript-Fehler [Zeile {line}]: {err}',
        'log-undo-success': 'Änderungen vom fehlgeschlagenen Skript zurückgesetzt (Undo).',
        'log-prep-self-repair': 'Selbstreparatur vorbereitet (Versuch {n})...',
        'log-process-cancelled-user': 'Prozess vom Benutzer erfolgreich abgebrochen.',
        'amsg-task-aborted-user': 'Die Aufgabe wurde auf deinen Wunsch unterbrochen. Wie weiter?',
        'tool-imageGen-label': 'Bildgenerator',
        'tool-videoGen-label': 'Videogenerator (Grok)',
        'tool-ttsGen-label': 'Sprachgenerator (TTS)',
        'tool-sttGen-label': 'Transkription (STT)',
        'tool-musicGen-label': 'Musikgenerator',
        'tool-sfxGen-label': 'Soundeffekte (SFX)',
        'tool-svgGen-label': 'SVG-Generator',
        'tool-pythonTools-label': 'Python-Umgebungen'
    },
    'es': {
        'greeting': 'HEXART.PL/AfterALL — ¡agente listo! ✨',
        'log-console-btn': 'Consola de registros',
        'prompt-placeholder': 'Escribe un comando para After Effects...',
        'status-ready': 'Listo', 'status-thinking': 'Pensando...', 'status-processing': 'Procesando...', 'status-done': 'Tarea completada.',
        'settings-title': 'Ajustes · HEXART.PL/AfterALL',
        'tab-general': 'General', 'tab-providers': 'Proveedores LLM', 'tab-tts-stt': 'TTS / STT', 'tab-features': 'Funciones', 'tab-paths': 'Rutas / Sandbox', 'tab-secrets': 'Claves API',
        'ui-lang-label': 'Idioma de la UI', 'proj-lang-label': 'Idioma del proyecto',
        'tts-voice-label': 'Voz (Gemini TTS)',
        'auto-debug-label': 'Autocorrección (máx. 3 intentos)',
        'vision-context-label': 'Enviar captura de la composición (Vision) para verificación',
        'use-grounding-label': 'Activar Google Search Grounding (solo Gemini)',
        'llm-section-title': '🤖 Modelo Principal (Lógica / LLM)',
        'base-model-label': 'Modelo Gemini (Lógica)',
        'img-section-title': '🎨 Generador de Imágenes',
        'tts-card-title': '🎙 Generador de Voz (TTS)',
        'el-voice-card-title': '👤 Voces de ElevenLabs',
        'stt-card-title': '📝 Speech-to-Text',
        'features-card-title': '⚙ Funciones activas',
        'tools-card-title': '🧩 Herramientas activas',
        'sandbox-card-title': '📁 Sandbox de Python',
        'api-key-label': 'Clave API Gemini',
        'api-key-openrouter': 'Clave API OpenRouter',
        'api-key-replicate': 'Clave API Replicate',
        'api-key-elevenlabs': 'Clave API ElevenLabs',
        'save-btn': 'Guardar', 'cancel-btn': 'Cancelar', 'close-btn': 'Cerrar', 'apply-btn': 'Aplicar',
        'api-help-title': '¿Cómo configurar la API?',
        'api-help-close-btn': 'Entendido',
        'api-help-steps-title': 'Paso a paso',
        'api-help-pricing': 'Precios / Capa gratuita',
        'api-help-usage': 'Se usa para',
        'api-help-notes': 'Notas',
        'api-help-troubleshoot': 'Problemas comunes',
        'sessions-title': 'Historial de sesiones', 'new-session-btn': '+ Nueva sesión',
        // Tools modal
        'tools-modal-title': 'Herramientas — Panel de Herramientas',
        'tools-filter-ph': '🔎 Filtrar...',
        'tools-refresh': '↻ Actualizar',
        'tools-select-prompt': 'Selecciona una herramienta de la lista.',
        'tools-status-on': 'activo', 'tools-status-off': 'desactivado',
        'tools-group-generators': 'Generadores',
        'tools-group-integrations': 'Integraciones',
        'tools-group-pyskills': 'Skills de Python',
        'tools-group-background': 'Procesos en segundo plano',
        'tools-group-other': 'Otros',
        'tools-empty-filter': 'Ninguna herramienta coincide con el filtro.',
        'tools-stats': '{total} herramientas · {active} activas',
        'tools-toggle-title': 'Activar / Desactivar',
        'tools-detail-overview': 'Resumen',
        'tools-detail-settings': 'Ajustes',
        'tools-detail-env': 'Entorno',
        'tools-detail-runtime': 'Tiempo de ejecución',
        'tools-detail-row-name': 'Nombre',
        'tools-detail-row-type': 'Tipo',
        'tools-detail-row-state': 'Estado',
        'tools-detail-row-env': 'Entorno venv',
        'tools-detail-row-packages': 'Paquetes',
        'tools-detail-row-created': 'Creado',
        'tools-detail-row-flag': 'Feature flag',
        'tools-detail-row-venv-folder': 'Carpeta venv',
        'tools-detail-stop-process': '⏹ Detener proceso',
        'tools-settings-reset': '↺ Restaurar predeterminados',
        'tools-settings-reset-confirm': '¿Restaurar los ajustes predeterminados de esta herramienta?',
        'tools-settings-no-config': 'Esta herramienta no tiene ajustes predefinidos. Puedes añadir tus propios pares clave/valor.',
        'q-form-title': 'Esperando tus indicaciones',
        'q-form-intro': 'Responde en el formulario o escribe directamente en el chat.',
        'q-form-suggestion-label': 'Sugerencia',
        'q-form-suggestion-none': 'ninguna',
        'q-form-placeholder': 'Escribe una respuesta o déjalo vacío para usar la sugerencia...',
        'q-form-submit': 'Confirmar',
        'q-form-submitted': 'Confirmado',
        'q-form-chat-resolved': 'Respondido por chat',
        'q-form-aborted': 'Cancelado...',
        'q-form-auto-applied': 'Sugerencias auto-aplicadas',
        'q-form-countdown': 'Auto-aplicación en {n}s · clic en cualquier campo para cancelar',
        'q-form-countdown-cancelled': 'Temporizador desactivado',
        'q-form-no-answer-fallback': 'Acepto tu sugerencia / sin comentarios.',
        'drag-to-ae-hint': 'Arrastra a cualquier sitio de After Effects (Proyecto / Línea de tiempo / Composición)',
        'drag-label': 'ARRASTRAR',
        'asset-grid-header': '{n} recursos generados — arrastra cualquiera a cualquier panel de After Effects.',
        'status-scanning-project': 'Escaneando proyecto de AE...',
        'status-fixing-error': 'Corrigiendo error (intento {n}/{max})...',
        'status-task-interrupted': 'Tarea interrumpida.',
        'status-awaiting-response': 'Esperando tu respuesta.',
        'status-task-error': 'Detenido tras error.',
        'status-comm-error': 'Error de comunicación.',
        'status-aborted': 'Cancelado.',
        'status-aborting': 'Cancelando...',
        'status-json-recovery-aborted': 'Detenido tras error JSON.',
        'status-task-completed-repetition': 'Tarea completada (anti-bucle).',
        'settings-saved-toast': '✓ Ajustes actualizados. LLM: {llm} ({model}) · Imágenes: {img} · TTS: {tts}.',
        'first-run-hint': '⚙ Abre Ajustes (engranaje) y configura tus claves API + elige proveedor LLM.',
        'amsg-no-api-key': '⚠ No has introducido la clave API. Haz clic en el engranaje para corregirlo.',
        'sysmsg-aborting-ops': '⚡ Cancelando operaciones a petición tuya...',
        'sysmsg-prev-aborted-new-task': '⚡ Tarea anterior cancelada. Comenzando una nueva.',
        'sysmsg-task-cancelled': 'La tarea fue interrumpida a petición tuya. ¿Qué sigue?',
        'sysmsg-comm-error': '⚠ Error de comunicación: {err}',
        'amsg-task-done': 'Tarea completada.',
        'amsg-doing-task': 'Trabajando en ello...',
        'amsg-execution-result': 'Resultado: {res}',
        'amsg-code-error-fixing': 'Error de código: {err}. Reparando...',
        'amsg-code-error-stopped': 'Error de código: {err}. Detenido por error.',
        'log-new-task': '--- Nueva tarea ---',
        'log-prompt': 'Prompt: "{text}"',
        'log-llm-call': 'Llamando al LLM ({model})...',
        'log-llm-responded': 'LLM respondió en {ms}ms (streaming).',
        'log-extendscript-call': 'Ejecutando ExtendScript en After Effects...',
        'log-extendscript-success': 'Script ejecutado con éxito en {ms}ms.',
        'log-extendscript-error': 'Error ExtendScript [Línea {line}]: {err}',
        'log-undo-success': 'Deshicimos los cambios del script fallido.',
        'log-prep-self-repair': 'Preparando auto-reparación (intento {n})...',
        'log-process-cancelled-user': 'Proceso cancelado correctamente por el usuario.',
        'amsg-task-aborted-user': 'La tarea fue interrumpida a petición tuya. ¿Qué sigue?',
        'tool-imageGen-label': 'Generador de Imágenes',
        'tool-videoGen-label': 'Generador de Vídeo (Grok)',
        'tool-ttsGen-label': 'Generador de Voz (TTS)',
        'tool-sttGen-label': 'Transcripción (STT)',
        'tool-musicGen-label': 'Generador de Música',
        'tool-sfxGen-label': 'Efectos de sonido (SFX)',
        'tool-svgGen-label': 'Generador SVG',
        'tool-pythonTools-label': 'Entornos Python'
    },
    'fr': {
        'greeting': 'HEXART.PL/AfterALL — agent prêt ! ✨',
        'log-console-btn': 'Console de logs',
        'prompt-placeholder': 'Saisissez une commande pour After Effects...',
        'status-ready': 'Prêt', 'status-thinking': 'Réflexion...', 'status-processing': 'Traitement...', 'status-done': 'Tâche terminée.',
        'settings-title': 'Paramètres · HEXART.PL/AfterALL',
        'tab-general': 'Général', 'tab-providers': 'Fournisseurs LLM', 'tab-tts-stt': 'TTS / STT', 'tab-features': 'Fonctions', 'tab-paths': 'Chemins / Sandbox', 'tab-secrets': 'Clés API',
        'ui-lang-label': 'Langue de l\'UI', 'proj-lang-label': 'Langue du contenu du projet',
        'tts-voice-label': 'Voix (Gemini TTS)',
        'auto-debug-label': 'Auto-correction (3 tentatives max.)',
        'vision-context-label': 'Envoyer une capture de la composition (Vision) pour vérification',
        'use-grounding-label': 'Activer Google Search Grounding (Gemini uniquement)',
        'llm-section-title': '🤖 Modèle principal (Logique / LLM)',
        'base-model-label': 'Modèle Gemini (Logique)',
        'img-section-title': '🎨 Générateur d\'images',
        'tts-card-title': '🎙 Générateur de voix (TTS)',
        'el-voice-card-title': '👤 Voix ElevenLabs',
        'stt-card-title': '📝 Speech-to-Text',
        'features-card-title': '⚙ Fonctions actives',
        'tools-card-title': '🧩 Outils actifs',
        'sandbox-card-title': '📁 Sandbox Python',
        'api-key-label': 'Clé API Gemini',
        'api-key-openrouter': 'Clé API OpenRouter',
        'api-key-replicate': 'Clé API Replicate',
        'api-key-elevenlabs': 'Clé API ElevenLabs',
        'save-btn': 'Enregistrer', 'cancel-btn': 'Annuler', 'close-btn': 'Fermer', 'apply-btn': 'Appliquer',
        'api-help-title': 'Comment configurer l\'API ?',
        'api-help-close-btn': 'Compris',
        'api-help-steps-title': 'Étape par étape',
        'api-help-pricing': 'Tarifs / Offre gratuite',
        'api-help-usage': 'Utilisé pour',
        'api-help-notes': 'Notes',
        'api-help-troubleshoot': 'Problèmes courants',
        'sessions-title': 'Historique des sessions', 'new-session-btn': '+ Nouvelle session',
        // Tools modal
        'tools-modal-title': 'Outils — Panneau Toolkit',
        'tools-filter-ph': '🔎 Filtrer...',
        'tools-refresh': '↻ Actualiser',
        'tools-select-prompt': 'Sélectionnez un outil dans la liste.',
        'tools-status-on': 'actif', 'tools-status-off': 'désactivé',
        'tools-group-generators': 'Générateurs',
        'tools-group-integrations': 'Intégrations',
        'tools-group-pyskills': 'Skills Python',
        'tools-group-background': 'Processus en arrière-plan',
        'tools-group-other': 'Autres',
        'tools-empty-filter': 'Aucun outil ne correspond au filtre.',
        'tools-stats': '{total} outils · {active} actifs',
        'tools-toggle-title': 'Activer / Désactiver',
        'tools-detail-overview': 'Aperçu',
        'tools-detail-settings': 'Paramètres',
        'tools-detail-env': 'Environnement',
        'tools-detail-runtime': 'Runtime',
        'tools-detail-row-name': 'Nom',
        'tools-detail-row-type': 'Type',
        'tools-detail-row-state': 'État',
        'tools-detail-row-env': 'Environnement venv',
        'tools-detail-row-packages': 'Paquets',
        'tools-detail-row-created': 'Créé',
        'tools-detail-row-flag': 'Feature flag',
        'tools-detail-row-venv-folder': 'Dossier venv',
        'tools-detail-stop-process': '⏹ Arrêter le processus',
        'tools-settings-reset': '↺ Réinitialiser aux valeurs par défaut',
        'tools-settings-reset-confirm': 'Réinitialiser les paramètres de cet outil ?',
        'tools-settings-no-config': 'Cet outil n\'a pas de paramètres prédéfinis. Ajoutez vos propres paires clé/valeur.',
        'q-form-title': 'En attente de tes indications',
        'q-form-intro': 'Réponds dans le formulaire OU écris directement dans le chat.',
        'q-form-suggestion-label': 'Suggestion',
        'q-form-suggestion-none': 'aucune',
        'q-form-placeholder': 'Tape une réponse ou laisse vide pour utiliser la suggestion...',
        'q-form-submit': 'Confirmer',
        'q-form-submitted': 'Confirmé',
        'q-form-chat-resolved': 'Répondu via le chat',
        'q-form-aborted': 'Interrompu...',
        'q-form-auto-applied': 'Suggestions auto-appliquées',
        'q-form-countdown': 'Auto-application dans {n}s · clique sur un champ pour annuler',
        'q-form-countdown-cancelled': 'Timer désactivé',
        'q-form-no-answer-fallback': 'J\'accepte ta suggestion / pas de remarques.',
        'drag-to-ae-hint': 'Glisse n\'importe où dans After Effects (Projet / Timeline / Composition)',
        'drag-label': 'GLISSER',
        'asset-grid-header': '{n} ressources générées — glisse n\'importe laquelle dans un panneau After Effects.',
        'status-scanning-project': 'Analyse du projet AE...',
        'status-fixing-error': 'Correction de l\'erreur (essai {n}/{max})...',
        'status-task-interrupted': 'Tâche interrompue.',
        'status-awaiting-response': 'En attente de ta réponse.',
        'status-task-error': 'Arrêté après erreur.',
        'status-comm-error': 'Erreur de communication.',
        'status-aborted': 'Annulé.',
        'status-aborting': 'Annulation...',
        'status-json-recovery-aborted': 'Arrêté après erreur JSON.',
        'status-task-completed-repetition': 'Tâche terminée (anti-boucle).',
        'settings-saved-toast': '✓ Paramètres mis à jour. LLM : {llm} ({model}) · Images : {img} · TTS : {tts}.',
        'first-run-hint': '⚙ Ouvre les Paramètres (roue dentée) et configure tes clés API + choisis un fournisseur LLM.',
        'amsg-no-api-key': '⚠ Aucune clé API saisie. Clique sur la roue dentée pour corriger.',
        'sysmsg-aborting-ops': '⚡ Annulation des opérations en cours sur ta demande...',
        'sysmsg-prev-aborted-new-task': '⚡ Tâche précédente annulée. Démarrage d\'une nouvelle.',
        'sysmsg-task-cancelled': 'La tâche a été interrompue à ta demande. On fait quoi ?',
        'sysmsg-comm-error': '⚠ Erreur de communication : {err}',
        'amsg-task-done': 'Tâche terminée.',
        'amsg-doing-task': 'Je travaille dessus...',
        'amsg-execution-result': 'Résultat : {res}',
        'amsg-code-error-fixing': 'Erreur de code : {err}. Tentative de réparation...',
        'amsg-code-error-stopped': 'Erreur de code : {err}. Arrêté en raison de l\'erreur.',
        'log-new-task': '--- Nouvelle tâche ---',
        'log-prompt': 'Prompt : "{text}"',
        'log-llm-call': 'Appel LLM ({model})...',
        'log-llm-responded': 'LLM a répondu en {ms}ms (streaming).',
        'log-extendscript-call': 'Appel ExtendScript dans After Effects...',
        'log-extendscript-success': 'Script exécuté avec succès en {ms}ms.',
        'log-extendscript-error': 'Erreur ExtendScript [Ligne {line}] : {err}',
        'log-undo-success': 'Modifications du script échoué annulées (Undo).',
        'log-prep-self-repair': 'Préparation à l\'auto-réparation (essai {n})...',
        'log-process-cancelled-user': 'Processus annulé avec succès par l\'utilisateur.',
        'amsg-task-aborted-user': 'La tâche a été interrompue à ta demande. On fait quoi ?',
        'tool-imageGen-label': 'Générateur d\'Images',
        'tool-videoGen-label': 'Générateur Vidéo (Grok)',
        'tool-ttsGen-label': 'Générateur de Voix (TTS)',
        'tool-sttGen-label': 'Transcription (STT)',
        'tool-musicGen-label': 'Générateur de Musique',
        'tool-sfxGen-label': 'Effets Sonores (SFX)',
        'tool-svgGen-label': 'Générateur SVG',
        'tool-pythonTools-label': 'Environnements Python'
    },
    'ja': {
        'greeting': 'HEXART.PL/AfterALL — エージェント準備完了！✨',
        'log-console-btn': 'ログコンソール',
        'prompt-placeholder': 'After Effects へのコマンドを入力...',
        'status-ready': '準備完了', 'status-thinking': '考え中...', 'status-processing': '処理中...', 'status-done': 'タスク完了。',
        'settings-title': '設定 · HEXART.PL/AfterALL',
        'tab-general': '一般', 'tab-providers': 'LLM プロバイダー', 'tab-tts-stt': 'TTS / STT', 'tab-features': '機能', 'tab-paths': 'パス / サンドボックス', 'tab-secrets': 'API キー',
        'ui-lang-label': 'UI 言語', 'proj-lang-label': 'プロジェクト言語',
        'tts-voice-label': '音声 (Gemini TTS)',
        'auto-debug-label': '自動セルフリペア (最大3回)',
        'vision-context-label': 'コンポのスクリーンショットを Vision に送信して検証',
        'use-grounding-label': 'Google 検索 Grounding を有効化 (Gemini のみ)',
        'llm-section-title': '🤖 メインモデル (ロジック / LLM)',
        'base-model-label': 'Gemini モデル (ロジック)',
        'img-section-title': '🎨 画像生成',
        'tts-card-title': '🎙 音声生成 (TTS)',
        'el-voice-card-title': '👤 ElevenLabs ボイス',
        'stt-card-title': '📝 音声認識 (STT)',
        'features-card-title': '⚙ アクティブ機能',
        'tools-card-title': '🧩 アクティブツール',
        'sandbox-card-title': '📁 Python サンドボックス',
        'api-key-label': 'Gemini API キー',
        'api-key-openrouter': 'OpenRouter API キー',
        'api-key-replicate': 'Replicate API キー',
        'api-key-elevenlabs': 'ElevenLabs API キー',
        'save-btn': '保存', 'cancel-btn': 'キャンセル', 'close-btn': '閉じる', 'apply-btn': '適用',
        'api-help-title': 'API の設定方法',
        'api-help-close-btn': 'OK',
        'api-help-steps-title': 'ステップバイステップ',
        'api-help-pricing': '料金 / 無料枠',
        'api-help-usage': '使用目的',
        'api-help-notes': '注意事項',
        'api-help-troubleshoot': 'よくある問題',
        'sessions-title': 'セッション履歴', 'new-session-btn': '+ 新しいセッション',
        // Tools modal
        'tools-modal-title': 'ツール — ツールキットパネル',
        'tools-filter-ph': '🔎 フィルター...',
        'tools-refresh': '↻ 更新',
        'tools-select-prompt': 'リストからツールを選択してください。',
        'tools-status-on': 'アクティブ', 'tools-status-off': '無効',
        'tools-group-generators': 'ジェネレーター',
        'tools-group-integrations': '統合',
        'tools-group-pyskills': 'Python スキル',
        'tools-group-background': 'バックグラウンドプロセス',
        'tools-group-other': 'その他',
        'tools-empty-filter': 'フィルターに一致するツールがありません。',
        'tools-stats': '{total} ツール · {active} アクティブ',
        'tools-toggle-title': '有効 / 無効',
        'tools-detail-overview': '概要',
        'tools-detail-settings': '設定',
        'tools-detail-env': '環境',
        'tools-detail-runtime': 'ランタイム',
        'tools-detail-row-name': '名前',
        'tools-detail-row-type': 'タイプ',
        'tools-detail-row-state': '状態',
        'tools-detail-row-env': 'venv 環境',
        'tools-detail-row-packages': 'パッケージ',
        'tools-detail-row-created': '作成日',
        'tools-detail-row-flag': '機能フラグ',
        'tools-detail-row-venv-folder': 'venv フォルダ',
        'tools-detail-stop-process': '⏹ プロセス停止',
        'tools-settings-reset': '↺ デフォルトに戻す',
        'tools-settings-reset-confirm': 'このツールの設定をデフォルトに戻しますか？',
        'tools-settings-no-config': 'このツールには定義済み設定がありません。独自のキー/値のペアを追加できます。',
        'q-form-title': '指示をお待ちしています',
        'q-form-intro': '下のフォームに入力するか、チャットに直接書き込んでください。',
        'q-form-suggestion-label': '提案',
        'q-form-suggestion-none': 'なし',
        'q-form-placeholder': '回答を入力するか、空欄のまま提案を使用...',
        'q-form-submit': '確定',
        'q-form-submitted': '確定済み',
        'q-form-chat-resolved': 'チャットで回答済み',
        'q-form-aborted': '中断...',
        'q-form-auto-applied': '提案を自動適用',
        'q-form-countdown': '{n}秒後に自動適用 · フィールドをクリックでキャンセル',
        'q-form-countdown-cancelled': '自動タイマー無効',
        'q-form-no-answer-fallback': 'あなたの提案に同意します / 追加コメントはありません。',
        'drag-to-ae-hint': 'After Effects の任意のパネルにドラッグ (Project / Timeline / Composition)',
        'drag-label': 'ドラッグ',
        'asset-grid-header': '{n} 個のアセットを生成しました — 任意の After Effects パネルにドラッグできます。',
        'status-scanning-project': 'AE プロジェクトをスキャン中...',
        'status-fixing-error': 'エラー修正中 (試行 {n}/{max})...',
        'status-task-interrupted': 'タスク中断。',
        'status-awaiting-response': '応答待ち。',
        'status-task-error': 'エラーで停止。',
        'status-comm-error': '通信エラー。',
        'status-aborted': 'キャンセル済み。',
        'status-aborting': 'キャンセル中...',
        'status-json-recovery-aborted': 'JSON エラーで停止。',
        'status-task-completed-repetition': 'タスク完了 (ループ防止)。',
        'settings-saved-toast': '✓ 設定を更新しました。LLM: {llm} ({model}) · 画像: {img} · TTS: {tts}。',
        'first-run-hint': '⚙ 設定 (歯車アイコン) を開き、API キーを設定して LLM プロバイダーを選択してください。',
        'amsg-no-api-key': '⚠ API キーが未入力です。歯車アイコンをクリックして修正してください。',
        'sysmsg-aborting-ops': '⚡ 現在の操作をキャンセル中...',
        'sysmsg-prev-aborted-new-task': '⚡ 前のタスクをキャンセル。新しいタスクを開始。',
        'sysmsg-task-cancelled': 'タスクは中断されました。次は何をしますか？',
        'sysmsg-comm-error': '⚠ 通信エラー: {err}',
        'amsg-task-done': 'タスク完了。',
        'amsg-doing-task': '作業中...',
        'amsg-execution-result': '実行結果: {res}',
        'amsg-code-error-fixing': 'コードエラー: {err}。修復を試みます...',
        'amsg-code-error-stopped': 'コードエラー: {err}。エラーで停止しました。',
        'log-new-task': '--- 新しいタスク ---',
        'log-prompt': 'プロンプト: "{text}"',
        'log-llm-call': 'LLM 呼び出し ({model})...',
        'log-llm-responded': 'LLM が {ms}ms で応答 (ストリーミング)。',
        'log-extendscript-call': 'After Effects で ExtendScript を呼び出し中...',
        'log-extendscript-success': 'スクリプトを {ms}ms で正常実行。',
        'log-extendscript-error': 'ExtendScript エラー [行 {line}]: {err}',
        'log-undo-success': '失敗したスクリプトの変更を取り消しました。',
        'log-prep-self-repair': '自己修復の準備中 (試行 {n})...',
        'log-process-cancelled-user': 'プロセスがユーザーにより正常にキャンセルされました。',
        'amsg-task-aborted-user': 'タスクは中断されました。次は何をしますか？',
        'tool-imageGen-label': '画像ジェネレーター',
        'tool-videoGen-label': '動画ジェネレーター (Grok)',
        'tool-ttsGen-label': '音声ジェネレーター (TTS)',
        'tool-sttGen-label': '転写 (STT)',
        'tool-musicGen-label': '音楽ジェネレーター',
        'tool-sfxGen-label': '効果音 (SFX)',
        'tool-svgGen-label': 'SVG ジェネレーター',
        'tool-pythonTools-label': 'Python 環境'
    }
};
// Helper: lookup translated string with EN/PL fallback
function t(key, fallback) {
    const code = (typeof currentLangCode === 'function') ? currentLangCode() : 'en';
    return (i18nDict[code] && i18nDict[code][key])
        || (i18nDict.en && i18nDict.en[key])
        || (i18nDict.pl && i18nDict.pl[key])
        || fallback || key;
}

    // Active language code resolver — used by translation helpers and the `t()` helper above
    let _activeLang = 'pl';
    window.currentLangCode = function () { return _activeLang; };

    function resolveLangCode(lang) {
        let targetLang = (lang === 'auto')
            ? (navigator.language ? navigator.language.substring(0, 2) : 'en')
            : lang;
        if (!i18nDict[targetLang]) {
            // Try 2-letter prefix from a 5-letter locale like 'en-US'
            const prefix = (targetLang || '').substring(0, 2);
            targetLang = i18nDict[prefix] ? prefix : 'en';
        }
        return targetLang;
    }
    function tr(key, lang) {
        const code = lang || _activeLang;
        return (i18nDict[code] && i18nDict[code][key])
            || (i18nDict.en && i18nDict.en[key])
            || (i18nDict.pl && i18nDict.pl[key])
            || key;
    }

    function applyTranslations(lang) {
        const targetLang = resolveLangCode(lang);
        _activeLang = targetLang;

        // text content (handles labels with nested checkbox)
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const val = tr(key, targetLang);
            if (val == null || val === key) return; // no translation found
            if (el.tagName === 'INPUT' || el.tagName === 'OPTION') {
                // Don't overwrite input value; option text is OK
                if (el.tagName === 'OPTION') el.textContent = val;
                return;
            }
            // Preserve nested controls (checkbox, help icon)
            const checkbox = el.querySelector('input[type="checkbox"]');
            const helpIcon = el.querySelector('.help-icon');
            if (checkbox) {
                el.innerHTML = '';
                el.appendChild(checkbox);
                el.appendChild(document.createTextNode(' ' + val));
                return;
            }
            if (helpIcon) {
                // Replace only the text node, preserve the help-icon button (which is a sibling, not child of the label)
                el.textContent = val;
                return;
            }
            el.textContent = val;
        });

        // placeholder
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
            const key = el.getAttribute('data-i18n-ph');
            const val = tr(key, targetLang);
            if (val && val !== key) el.placeholder = val;
        });
        // title attribute
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            const val = tr(key, targetLang);
            if (val && val !== key) el.title = val;
        });
        // aria-label
        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            const val = tr(key, targetLang);
            if (val && val !== key) el.setAttribute('aria-label', val);
        });
    }

    // Initialize UI settings
    if (agent.apiKey) apiKeyInput.value = agent.apiKey;
    if (agent.openrouterApiKey && openrouterApiInput) openrouterApiInput.value = agent.openrouterApiKey;
    if (agent.replicateApiKey) replicateApiInput.value = agent.replicateApiKey;
    if (agent.elevenlabsApiKey) elevenlabsApiInput.value = agent.elevenlabsApiKey;
    if (llmProviderSelect) llmProviderSelect.value = agent.llmProvider || 'gemini';
    if (imgProviderSelect) imgProviderSelect.value = agent.imgProvider || 'gemini';
    if (openrouterLLMModelInput) openrouterLLMModelInput.value = agent.openrouterLLMModel || '';
    if (openrouterGroundingModelInput) openrouterGroundingModelInput.value = agent.openrouterGroundingModel || '';
    if (openrouterImgModelInput) openrouterImgModelInput.value = agent.openrouterImageModel || '';
    if (lmstudioBaseUrlInput) lmstudioBaseUrlInput.value = agent.lmstudioBaseUrl || 'http://localhost:1234';
    if (pythonSandboxPathInput) pythonSandboxPathInput.value = agent.pythonSandboxPath || '';
    if (toolsCachePathInput) toolsCachePathInput.value = agent.toolsCachePath || '';

    ttsVoiceSelect.value = agent.ttsVoice || 'Auto';
    uiLangSelect.value = agent.uiLanguage || 'auto';
    projLangSelect.value = agent.projectLanguage || 'auto';
    if (agent.useGrounding !== undefined) useGroundingCheck.checked = agent.useGrounding;

    applyTranslations(uiLangSelect.value);

    // ---- Settings tabs ------------------------------------------------
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-tab');
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.settings-tab-content').forEach(c => {
                c.classList.toggle('hidden', c.getAttribute('data-tab-content') !== target);
            });
        });
    });

    // ===== Permission Request Flow =====================================
    // Asks user to approve a sensitive operation. Returns Promise<'allow'|'deny'>.
    const permOverlay = document.getElementById('permission-overlay');
    const permTitle = document.getElementById('perm-title');
    const permIcon = document.getElementById('perm-icon');
    const permIntro = document.getElementById('perm-intro');
    const permDetails = document.getElementById('perm-details');
    const permReason = document.getElementById('perm-reason');
    const permScope = document.getElementById('perm-scope');
    const permAllowBtn = document.getElementById('perm-allow-btn');
    const permDenyBtn = document.getElementById('perm-deny-btn');
    const permCloseBtn = document.getElementById('close-permission-btn');

    const operationLabels = {
        delete_layer: { icon: '🗑', pl: 'Usuwanie warstwy', en: 'Delete layer' },
        delete_project_item: { icon: '🗑', pl: 'Usuwanie elementu z projektu', en: 'Delete project item' },
        overwrite_user_file: { icon: '⚠', pl: 'Nadpisanie pliku użytkownika', en: 'Overwrite user file' },
        modify_protected: { icon: '✎', pl: 'Modyfikacja chronionego elementu', en: 'Modify protected item' },
        run_long_python: { icon: '⏳', pl: 'Długie zadanie Python', en: 'Long-running Python task' },
        install_python_packages: { icon: '📦', pl: 'Instalacja pakietów Python', en: 'Install Python packages' },
        external_http_call: { icon: '🌐', pl: 'Połączenie z internetem', en: 'External HTTP call' },
        file_system_write: { icon: '💾', pl: 'Zapis na dysku', en: 'Write to filesystem' }
    };

    function requestPermission(operation, target, reason) {
        return new Promise((resolve) => {
            if (!permManager) { resolve('allow'); return; }
            const decision = permManager.check(operation, target);
            if (decision === 'allow') { resolve('allow'); return; }
            if (decision === 'deny') { resolve('deny'); return; }
            // Need to ask
            const opMeta = operationLabels[operation] || { icon: '⚖', pl: operation, en: operation };
            permIcon.textContent = opMeta.icon;
            permTitle.textContent = (opMeta[_activeLang] || opMeta.en) || operation;
            permIntro.textContent = (_activeLang === 'pl')
                ? 'Agent prosi o zgodę na operację która może wpłynąć na istniejące dane projektu.'
                : 'The agent is requesting permission for an operation that may affect existing project data.';
            permDetails.innerHTML = `
                <div style="display:flex; gap:8px; align-items:center; margin-bottom: 6px;">
                    <span style="font-size:18px;">${opMeta.icon}</span>
                    <strong>${escapeAttr((opMeta[_activeLang] || opMeta.en))}</strong>
                </div>
                <div style="font-size:11.5px; color: var(--text-secondary); font-family: monospace; word-break: break-all;">
                    ${(_activeLang === 'pl' ? 'Cel: ' : 'Target: ')}<span style="color: var(--text-primary);">${escapeAttr(target || '*')}</span>
                </div>
            `;
            permReason.textContent = (_activeLang === 'pl' ? 'Uzasadnienie agenta: ' : 'Agent\'s reason: ') + (reason || (_activeLang === 'pl' ? '(brak uzasadnienia)' : '(no reason given)'));
            permScope.value = 'once';
            permOverlay.classList.remove('hidden');

            const finish = (dec) => {
                permOverlay.classList.add('hidden');
                permAllowBtn.removeEventListener('click', onAllow);
                permDenyBtn.removeEventListener('click', onDeny);
                permCloseBtn.removeEventListener('click', onDeny);
                resolve(dec);
            };
            const onAllow = () => {
                const mode = permScope.value;
                const durationMs = (mode === 'temporary') ? (60 * 60 * 1000) : undefined;
                permManager.grant(operation, target, 'allow', mode, durationMs);
                addLog('PERM allow: ' + operation + ' / ' + (target || '*') + ' (mode: ' + mode + ')', 'success');
                finish('allow');
            };
            const onDeny = () => {
                const mode = permScope.value;
                if (mode === 'always-target' || mode === 'always-type') {
                    permManager.grant(operation, target, 'deny', mode);
                    addLog('PERM deny (saved): ' + operation + ' / ' + (target || '*'), 'warning');
                } else {
                    addLog('PERM deny: ' + operation + ' / ' + (target || '*'), 'warning');
                }
                finish('deny');
            };
            permAllowBtn.addEventListener('click', onAllow);
            permDenyBtn.addEventListener('click', onDeny);
            permCloseBtn.addEventListener('click', onDeny);
        });
    }

    // Render saved permission rules in settings
    function renderPermissionRules() {
        const listEl = document.getElementById('perm-rules-list');
        if (!listEl || !permManager) return;
        const rules = permManager.list();
        listEl.innerHTML = '';
        if (rules.length === 0) {
            listEl.innerHTML = '<div style="font-size:11px; color: var(--text-secondary); text-align: center; padding: 0.6rem;">'
                + (_activeLang === 'pl' ? 'Brak zapisanych decyzji uprawnień.' : 'No saved permission decisions.') + '</div>';
            return;
        }
        rules.forEach(r => {
            const opMeta = operationLabels[r.operation] || { icon: '⚖', pl: r.operation, en: r.operation };
            const row = document.createElement('div');
            row.className = 'perm-rule';
            const allowClass = r.decision === 'allow' ? 'allow' : 'deny';
            const decisionIcon = r.decision === 'allow' ? '✓' : '✕';
            const expiresLabel = r.expires_at
                ? ' · expires ' + new Date(r.expires_at).toLocaleString()
                : '';
            row.innerHTML = `
                <div class="perm-rule-icon ${allowClass}">${decisionIcon}</div>
                <div class="perm-rule-meta">
                    <div class="perm-rule-op">${opMeta.icon} ${escapeAttr(opMeta[_activeLang] || opMeta.en)}</div>
                    <div class="perm-rule-target">${escapeAttr(r.target || '*')}</div>
                    <div class="perm-rule-meta-info">${escapeAttr(r.decision.toUpperCase())} · saved ${new Date(r.created_at).toLocaleDateString()}${expiresLabel}</div>
                </div>
                <button class="mini-btn" data-revoke="${escapeAttr(r.operation)}|${escapeAttr(r.target)}" title="Cofnij decyzję">✕</button>
            `;
            row.querySelector('[data-revoke]').addEventListener('click', () => {
                permManager.revoke(r.operation, r.target);
                renderPermissionRules();
                addLog(tr('log-perm-rule-revoked').replace('{op}', r.operation).replace('{target}', r.target), 'info');
            });
            listEl.appendChild(row);
        });
    }
    const permClearAllBtn = document.getElementById('perm-clear-all-btn');
    if (permClearAllBtn) permClearAllBtn.addEventListener('click', () => {
        if (confirm(_activeLang === 'pl' ? 'Wyczyścić wszystkie zapisane decyzje uprawnień?' : 'Clear all saved permission decisions?')) {
            permManager.clearAll();
            renderPermissionRules();
        }
    });

    // Expose for agent.js to call (in case agent code needs gating)
    window.requestPermission = requestPermission;

    // ===== Save-Project Pre-flight =====================================
    // Returns Promise<'saved' | 'temp' | 'cancelled'>.
    // - 'saved'     → project is now saved on disk, assets go to <projectFolder>/aisist_assets/
    // - 'temp'      → user explicitly opted for temp folders despite warning
    // - 'cancelled' → user backed out entirely; task should not start
    const saveProjectOverlay = document.getElementById('save-project-overlay');
    const saveProjectStep2 = document.getElementById('save-project-step2');
    const saveProjectFooter1 = document.getElementById('save-project-footer-step1');
    const saveProjectFooter2 = document.getElementById('save-project-footer-step2');
    const saveProjectCloseBtn = document.getElementById('save-project-close-btn');
    const saveProjectSaveBtn = document.getElementById('save-project-save-btn');
    const saveProjectSkipBtn = document.getElementById('save-project-skip-btn');
    const saveProjectBackBtn = document.getElementById('save-project-back-btn');
    const saveProjectConfirmSkipBtn = document.getElementById('save-project-confirm-skip-btn');
    const saveProjectSaveAnywayBtn = document.getElementById('save-project-save-anyway-btn');

    function showSaveProjectRecommendation() {
        return new Promise((resolve) => {
            // Reset to step 1
            saveProjectStep2.classList.add('hidden');
            saveProjectFooter1.classList.remove('hidden');
            saveProjectFooter1.style.display = 'flex';
            saveProjectFooter2.classList.add('hidden');
            saveProjectFooter2.style.display = '';
            saveProjectOverlay.classList.remove('hidden');

            const cleanup = (result) => {
                saveProjectOverlay.classList.add('hidden');
                saveProjectSaveBtn.removeEventListener('click', onSave);
                saveProjectSkipBtn.removeEventListener('click', onSkip);
                saveProjectBackBtn.removeEventListener('click', onBack);
                saveProjectConfirmSkipBtn.removeEventListener('click', onConfirmSkip);
                saveProjectSaveAnywayBtn.removeEventListener('click', onSave);
                saveProjectCloseBtn.removeEventListener('click', onClose);
                resolve(result);
            };
            const onSave = async () => {
                saveProjectSaveBtn.disabled = true;
                saveProjectSaveAnywayBtn.disabled = true;
                try {
                    const res = await agent.triggerProjectSave(true);
                    saveProjectSaveBtn.disabled = false;
                    saveProjectSaveAnywayBtn.disabled = false;
                    if (res && res.saved) {
                        addLog(tr('save-project-saved-log') + ' ' + (res.file || ''), 'success');
                        cleanup('saved');
                    } else {
                        addLog(tr('save-project-save-cancelled-log'), 'info');
                        // Stay on the modal so the user can try again or skip
                    }
                } catch (e) {
                    saveProjectSaveBtn.disabled = false;
                    saveProjectSaveAnywayBtn.disabled = false;
                    addLog('Save error: ' + e.message, 'error');
                }
            };
            const onSkip = () => {
                // Go to step 2 — consequences explanation
                saveProjectStep2.classList.remove('hidden');
                saveProjectFooter1.classList.add('hidden');
                saveProjectFooter1.style.display = 'none';
                saveProjectFooter2.classList.remove('hidden');
                saveProjectFooter2.style.display = 'flex';
            };
            const onBack = () => {
                saveProjectStep2.classList.add('hidden');
                saveProjectFooter1.classList.remove('hidden');
                saveProjectFooter1.style.display = 'flex';
                saveProjectFooter2.classList.add('hidden');
                saveProjectFooter2.style.display = 'none';
            };
            const onConfirmSkip = () => {
                addLog(tr('save-project-using-temp-log'), 'warning');
                cleanup('temp');
            };
            const onClose = () => {
                addLog(tr('save-project-cancelled-log'), 'info');
                cleanup('cancelled');
            };
            saveProjectSaveBtn.addEventListener('click', onSave);
            saveProjectSkipBtn.addEventListener('click', onSkip);
            saveProjectBackBtn.addEventListener('click', onBack);
            saveProjectConfirmSkipBtn.addEventListener('click', onConfirmSkip);
            saveProjectSaveAnywayBtn.addEventListener('click', onSave);
            saveProjectCloseBtn.addEventListener('click', onClose);
        });
    }
    window.showSaveProjectRecommendation = showSaveProjectRecommendation;

    // ===== MCP Bridge UI =================================================
    const mcpEnabledCheck = document.getElementById('mcp-enabled');
    const mcpPortInput = document.getElementById('mcp-port');
    const mcpTokenInput = document.getElementById('mcp-token');
    const mcpToggleBtn = document.getElementById('mcp-toggle-btn');
    const mcpRegenToken = document.getElementById('mcp-regen-token');
    const mcpCopyToken = document.getElementById('mcp-copy-token');
    const mcpCopyConfig = document.getElementById('mcp-copy-config');
    const mcpStatusEl = document.getElementById('mcp-status');
    const mcpConfigSnippet = document.getElementById('mcp-config-snippet');

    function updateMcpUI() {
        if (!mcpBridge) return;
        const running = mcpBridge.isRunning();
        if (mcpEnabledCheck) mcpEnabledCheck.checked = window.diskStorage.getItem('hexart_mcp_enabled') === 'true';
        if (mcpPortInput) mcpPortInput.value = mcpBridge.port;
        if (mcpTokenInput) mcpTokenInput.value = mcpBridge.token || '';
        if (mcpToggleBtn) {
            mcpToggleBtn.textContent = running ? '■ Stop' : '▶ Start';
            mcpToggleBtn.classList.toggle('danger', running);
        }
        if (mcpStatusEl) {
            mcpStatusEl.innerHTML = running
                ? '<div style="color: #34d399;">✓ Bridge listening on <code>http://' + mcpBridge.host + ':' + mcpBridge.port + '</code></div>'
                + '<div style="color: var(--text-secondary); margin-top: 4px;">Logs: ' + (mcpBridge.logBuffer.length) + ' entries</div>'
                : '<div style="color: var(--text-secondary);">⊘ Bridge wyłączony</div>';
        }
        if (mcpConfigSnippet) {
            const cfg = {
                mcpServers: {
                    afterall: {
                        command: 'npx',
                        args: ['-y', '@hexart/afterall-mcp'],
                        env: {
                            AFTERALL_PORT: String(mcpBridge.port),
                            AFTERALL_TOKEN: mcpBridge.token || '(REGENERATE_TOKEN_FIRST)'
                        }
                    }
                }
            };
            mcpConfigSnippet.textContent = JSON.stringify(cfg, null, 2);
        }
    }

    if (mcpToggleBtn) mcpToggleBtn.addEventListener('click', async () => {
        if (!mcpBridge) return;
        if (mcpBridge.isRunning()) {
            await mcpBridge.stop();
            addLog('MCP Bridge stopped.', 'info');
        } else {
            if (mcpPortInput) mcpBridge.setPort(parseInt(mcpPortInput.value, 10) || 7890);
            if (!mcpBridge.token) { mcpBridge.generateToken(); window.diskStorage.setItem('hexart_mcp_token', mcpBridge.token); }
            try {
                await mcpBridge.start();
                addLog('MCP Bridge listening on port ' + mcpBridge.port, 'success');
                window.diskStorage.setItem('hexart_mcp_port', String(mcpBridge.port));
            } catch (e) {
                addLog('MCP Bridge start failed: ' + e.message, 'error');
                appendMessage('system', tr('sysmsg-bridge-failed-start').replace('{err}', e.message));
            }
        }
        updateMcpUI();
    });
    if (mcpRegenToken) mcpRegenToken.addEventListener('click', () => {
        if (!mcpBridge) return;
        mcpBridge.generateToken();
        window.diskStorage.setItem('hexart_mcp_token', mcpBridge.token);
        addLog('Nowy MCP token wygenerowany.', 'success');
        updateMcpUI();
    });
    if (mcpCopyToken) mcpCopyToken.addEventListener('click', () => {
        if (!mcpBridge || !mcpBridge.token) return;
        try { navigator.clipboard.writeText(mcpBridge.token); addLog('Token skopiowany do schowka.', 'info'); } catch(_) {}
    });
    if (mcpCopyConfig) mcpCopyConfig.addEventListener('click', () => {
        if (!mcpConfigSnippet) return;
        try { navigator.clipboard.writeText(mcpConfigSnippet.textContent); addLog('Konfiguracja MCP skopiowana.', 'info'); } catch(_) {}
    });
    if (mcpEnabledCheck) mcpEnabledCheck.addEventListener('change', () => {
        window.diskStorage.setItem('hexart_mcp_enabled', mcpEnabledCheck.checked ? 'true' : 'false');
    });
    if (mcpPortInput) mcpPortInput.addEventListener('change', () => {
        if (mcpBridge) {
            const p = parseInt(mcpPortInput.value, 10) || 7890;
            if (mcpBridge.isRunning()) {
                appendMessage('system', tr('sysmsg-bridge-port-changed'));
            }
            window.diskStorage.setItem('hexart_mcp_port', String(p));
            mcpBridge.setPort(p);
            updateMcpUI();
        }
    });

    // Wire MCP bridge to the UI logger so its log lines appear in the panel
    if (mcpBridge) {
        mcpBridge.setUiLogger((msg, level) => { try { addLog(msg, level); } catch(_) {} });
    }

    // Expose runPrompt handler for /send_prompt MCP endpoint
    window._mcpRunPrompt = async function(body) {
        if (isAgentProcessing) throw new Error('Agent is busy — wait for current task to finish.');
        // Inject into UI as if user typed
        promptInput.value = body.prompt;
        const wait = body.wait_for_completion !== false;
        if (!wait) {
            // Async path: return task_id, run in background
            const taskId = mcpBridge.createTask();
            handleSend().then(() => {
                mcpBridge.updateTask(taskId, { status: 'done', result: { message: 'Task complete (see plugin chat for details)' } });
            }).catch(err => {
                mcpBridge.updateTask(taskId, { status: 'failed', error: err.message });
            });
            return { task_id: taskId, status: 'running' };
        }
        // Sync path: await full completion
        await handleSend();
        // Build a concise result
        return {
            status: 'done',
            history_length: agent.history.length,
            last_message: agent.history.length > 0 ? (agent.history[agent.history.length - 1].parts[0].text || '').substring(0, 2000) : ''
        };
    };

    // ===== Pipeline UI helper =========================================
    function startPipeline(title, subtitle, icon) {
        if (currentPipeline) { try { currentPipeline.finish(); } catch(_) {} currentPipeline = null; }
        const P = window.AfterAllOrchestration && window.AfterAllOrchestration.Pipeline;
        if (!P) return null;
        currentPipeline = new P(chatContainer, { title: title || 'Pipeline', subtitle: subtitle || '', icon: icon || '⚙' });
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return currentPipeline;
    }
    function pipelineAdd(step) {
        if (!currentPipeline) return null;
        const id = currentPipeline.addStep(step);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return id;
    }
    function pipelineUpdate(id, patch) {
        if (!currentPipeline) return;
        currentPipeline.updateStep(id, patch);
    }
    function pipelineFinish(summary) {
        if (!currentPipeline) return;
        currentPipeline.finish(summary);
        currentPipeline = null;
    }

    // ===== API Help Modal (multi-language) =============================
    // Per-API instructional content. Each entry has: title, intro, steps, pricing, usage, notes.
    const apiHelpContent = {
        gemini: {
            icon: '🤖',
            title: { pl: 'Google Gemini API', en: 'Google Gemini API' },
            intro: {
                pl: 'Gemini to silnik LLM od Google — używany przez tę wtyczkę do logiki agenta, generowania obrazów (Nano Banana), syntezy mowy (TTS) i muzyki (Lyria 3 Pro). Klucz jest darmowy do uzyskania. Klucz <i>nie ma scope\'ów</i> — daje pełny dostęp do wszystkich endpointów dostępnych w Twoim projekcie Google Cloud.',
                en: 'Gemini is Google\'s LLM engine — used here for the agent\'s logic, image generation (Nano Banana), TTS, and music (Lyria 3 Pro). The key is free to obtain. The key has <i>no scopes</i> — it grants full access to all endpoints enabled in your Google Cloud project.'
            },
            steps: [
                { pl: 'Otwórz <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio → API keys</a> (zaloguj się kontem Google).', en: 'Open <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio → API keys</a> (sign in with Google).' },
                { pl: 'Kliknij <b>"Create API key"</b>, wybierz nowy lub istniejący projekt Google Cloud.', en: 'Click <b>"Create API key"</b>, choose a new or existing Google Cloud project.' },
                { pl: '<b>API Restrictions:</b> domyślnie klucz ma "Don\'t restrict key" — zostaw tak. Jeśli ograniczasz, MUSISZ zaznaczyć <code>Generative Language API</code> (obejmuje LLM + obrazy + TTS + Lyria + grounding).', en: '<b>API Restrictions:</b> the default is "Don\'t restrict key" — leave it. If you restrict it, you MUST allow <code>Generative Language API</code> (covers LLM + images + TTS + Lyria + grounding).' },
                { pl: '<b>Application Restrictions:</b> zostaw <i>"None"</i> — wtyczka działa lokalnie z różnymi IP, a restrykcje HTTP referrer / IP nie zadziałają.', en: '<b>Application Restrictions:</b> leave it as <i>"None"</i> — the plugin runs locally with varying IPs, and HTTP referrer / IP restrictions will not work.' },
                { pl: 'Skopiuj wygenerowany klucz (zaczyna się od <code>AIzaSy...</code>).', en: 'Copy the generated key (starts with <code>AIzaSy...</code>).' },
                { pl: 'Wklej go w polu <b>"Klucz API Gemini"</b> w zakładce Klucze API i zapisz.', en: 'Paste it into the <b>"Gemini API Key"</b> field in the API Keys tab and save.' }
            ],
            link: 'https://aistudio.google.com/apikey',
            pricing: {
                pl: 'Darmowy tier: ~15 zapytań/min, 1500/dziennie. Płatny: pay-as-you-go (od $0,075/1M tokenów dla Flash).',
                en: 'Free tier: ~15 req/min, 1500/day. Paid: pay-as-you-go (from $0.075/1M tokens for Flash).'
            },
            usage: {
                pl: ['LLM — główna logika agenta', 'Generowanie obrazów (Nano Banana / Imagen)', 'Synteza mowy (TTS)', 'Generowanie muzyki (Lyria 3 Pro)', 'Google Search Grounding (live web)'],
                en: ['LLM — main agent logic', 'Image generation (Nano Banana / Imagen)', 'Text-to-Speech', 'Music generation (Lyria 3 Pro)', 'Google Search Grounding (live web)']
            },
            troubleshoot: {
                pl: ['<b>API_KEY_INVALID</b>: klucz został usunięty lub źle przepisany — wygeneruj nowy.', '<b>QUOTA_EXCEEDED</b>: przekroczono dzienny limit free tieru — poczekaj do reset lub przejdź na płatny plan.', '<b>403 from region</b>: niektóre modele dostępne tylko w USA — użyj VPN albo wybierz inny model.'],
                en: ['<b>API_KEY_INVALID</b>: key was deleted or mistyped — generate a new one.', '<b>QUOTA_EXCEEDED</b>: free-tier daily limit hit — wait for reset or move to paid.', '<b>403 from region</b>: some models are US-only — use a VPN or pick another model.']
            }
        },
        openrouter: {
            icon: '🌐',
            title: { pl: 'OpenRouter API', en: 'OpenRouter API' },
            intro: {
                pl: 'OpenRouter to agregator dostawców LLM — w jednym kluczu masz dostęp do Claude (Anthropic), GPT (OpenAI), Llama (Meta), Grok (xAI), Mistral i wielu innych. Płacisz tylko za użycie, każdy model ma własny cennik.',
                en: 'OpenRouter is an LLM aggregator — one key gives you access to Claude (Anthropic), GPT (OpenAI), Llama (Meta), Grok (xAI), Mistral and many more. Pay-as-you-go per model.'
            },
            steps: [
                { pl: 'Załóż konto na <a href="https://openrouter.ai/" target="_blank">openrouter.ai</a> (Google / GitHub).', en: 'Create an account at <a href="https://openrouter.ai/" target="_blank">openrouter.ai</a> (Google / GitHub).' },
                { pl: 'Doładuj kredyty: <a href="https://openrouter.ai/credits" target="_blank">openrouter.ai/credits</a> (minimum $5). Bez kredytów dostępne tylko modele <code>:free</code>.', en: 'Top up credits: <a href="https://openrouter.ai/credits" target="_blank">openrouter.ai/credits</a> (minimum $5). Without credits only <code>:free</code> models are accessible.' },
                { pl: 'Wygeneruj klucz: <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a> → "Create Key".', en: 'Generate a key: <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a> → "Create Key".' },
                { pl: '<b>Pole "Name":</b> np. <code>afterALL</code>. <b>"Credit limit":</b> zostaw puste = bez limitu (lub ustaw $5/$10 jako bezpiecznik). <b>"Models":</b> zostaw puste = wszystkie modele (lub wybierz konkretne by ograniczyć ryzyko).', en: '<b>"Name" field:</b> e.g. <code>afterALL</code>. <b>"Credit limit":</b> leave empty = unlimited (or set $5/$10 as a safety cap). <b>"Models":</b> leave empty = all models (or restrict to specific ones to limit risk).' },
                { pl: 'OpenRouter <b>NIE</b> używa systemu scope\'ów per-endpoint — jeden klucz daje dostęp do całego API (models, chat, generations).', en: 'OpenRouter does <b>NOT</b> use per-endpoint scopes — a single key grants access to the entire API (models, chat, generations).' },
                { pl: 'Skopiuj klucz (zaczyna się od <code>sk-or-...</code>) i wklej w zakładce Klucze API.', en: 'Copy the key (starts with <code>sk-or-...</code>) and paste it in the API Keys tab.' },
                { pl: 'Wybierz model w zakładce Dostawcy LLM → klik 📋 by przeglądać katalog z filtrami cen.', en: 'Pick a model in the LLM Providers tab → click 📋 to browse the catalog with price filters.' }
            ],
            link: 'https://openrouter.ai/keys',
            pricing: {
                pl: 'Cena per model — np. Claude 3.5 Sonnet ~$3/1M input, GPT-4o ~$5/1M input. Modele FREE: Llama, niektóre Mistral, Grok Beta (z limitami).',
                en: 'Price per model — e.g. Claude 3.5 Sonnet ~$3/1M input, GPT-4o ~$5/1M input. Free models: Llama, some Mistral, Grok Beta (rate-limited).'
            },
            usage: {
                pl: ['Główna logika agenta (alternatywa dla Gemini)', 'Niektóre modele Vision (Claude, GPT-4o)', 'Generowanie obrazów (modele Image-capable)'],
                en: ['Main agent logic (alternative to Gemini)', 'Vision-capable models (Claude, GPT-4o)', 'Image generation (Image-capable models)']
            },
            troubleshoot: {
                pl: ['<b>401 Unauthorized</b>: klucz wygasł lub błędny — wygeneruj nowy.', '<b>402 Insufficient credits</b>: doładuj konto.', '<b>404 Model not found</b>: model został wycofany — wybierz inny.'],
                en: ['<b>401 Unauthorized</b>: key expired or wrong — generate a new one.', '<b>402 Insufficient credits</b>: top up your account.', '<b>404 Model not found</b>: model retired — pick another.']
            }
        },
        elevenlabs: {
            icon: '🎙',
            title: { pl: 'ElevenLabs API', en: 'ElevenLabs API' },
            intro: {
                pl: 'ElevenLabs to najlepsza usługa syntezy mowy (TTS) i word-level transkrypcji (Scribe v2). Daje dostęp do tysięcy głosów w bibliotece publicznej + klonowania własnego głosu. <b>UWAGA:</b> przy generowaniu klucza MUSISZ wybrać konkretne uprawnienia (scope/permissions) — domyślnie ElevenLabs daje minimalne, przez co nie zadziałają biblioteka głosów ani lista modeli.',
                en: 'ElevenLabs is a top-tier TTS service plus word-level transcription (Scribe v2). <b>IMPORTANT:</b> when creating a key you MUST grant specific scopes/permissions — by default ElevenLabs assigns minimal access, which blocks voice library and model listing.'
            },
            steps: [
                { pl: 'Załóż konto na <a href="https://elevenlabs.io/sign-up" target="_blank">elevenlabs.io</a>.', en: 'Sign up at <a href="https://elevenlabs.io/sign-up" target="_blank">elevenlabs.io</a>.' },
                { pl: 'Przejdź do <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank">Settings → API Keys</a> (lub: avatar w prawym górnym rogu → "API Keys").', en: 'Open <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank">Settings → API Keys</a> (or: top-right avatar → "API Keys").' },
                { pl: 'Kliknij <b>"Create API Key"</b>, nazwij ją (np. <code>afterALL</code>).', en: 'Click <b>"Create API Key"</b>, name it (e.g. <code>afterALL</code>).' },
                { pl: '<b>Sekcja "Access" — KLUCZOWY KROK:</b> rozwiń listę "Access to all endpoints" i wybierz <b>"Restrict key"</b> aby zobaczyć checkboxy scope\'ów. NAJPROŚCIEJ: zostaw "Has access to all" — wtedy wszystko zadziała. Jeśli chcesz minimalny zestaw uprawnień, zaznacz dokładnie te scope\'y (lista poniżej w sekcji "Wykorzystywane do").', en: '<b>"Access" section — CRITICAL STEP:</b> expand "Access to all endpoints" and pick <b>"Restrict key"</b> to see scope checkboxes. SIMPLEST: leave "Has access to all" enabled — everything will work. For a minimal set of permissions, tick the scopes listed below in "Used for".' },
                { pl: '<b>Sekcja "Workspace permissions":</b> jeśli pracujesz na koncie Team/Workspace, dodatkowo przyznaj rolę co najmniej <b>"Member"</b> (lub wyższą).', en: '<b>"Workspace permissions" section:</b> on a Team/Workspace account additionally grant at least <b>"Member"</b> role (or higher).' },
                { pl: 'Kliknij <b>"Create"</b>, skopiuj klucz (<code>sk_...</code>) i wklej w polu <b>"Klucz ElevenLabs API"</b>. <b>UWAGA:</b> klucz jest pokazywany TYLKO RAZ — zapisz go bezpiecznie.', en: 'Click <b>"Create"</b>, copy the key (<code>sk_...</code>) and paste it into the <b>"ElevenLabs API Key"</b> field. <b>NOTE:</b> the key is shown ONLY ONCE — store it safely.' },
                { pl: 'W zakładce TTS/STT wybierz dostawcę <i>ElevenLabs</i>, kliknij ↻ aby pobrać listę modeli, a następnie 📋 aby wybrać domyślne głosy męski/żeński z biblioteki.', en: 'In the TTS/STT tab pick provider <i>ElevenLabs</i>, click ↻ to fetch models, then 📋 to choose default male/female voices from the library.' }
            ],
            link: 'https://elevenlabs.io/app/settings/api-keys',
            pricing: {
                pl: 'Free: 10k znaków/miesiąc, 10 custom voices. Starter ($5/mies): 30k znaków. Creator ($22/mies): 100k znaków + voice cloning HD. STT (Scribe v2): liczone osobno wg minut audio.',
                en: 'Free: 10k chars/month, 10 custom voices. Starter ($5/mo): 30k chars. Creator ($22/mo): 100k chars + voice cloning HD. STT (Scribe v2): billed separately per audio minute.'
            },
            usage: {
                pl: [
                    '<b>Scope\'y które MUSISZ zaznaczyć w polu "Access" (przy tworzeniu klucza):</b>',
                    '🔓 <code>voices_read</code> — odczyt listy "My Voices" (potrzebne dla 📋 wyboru głosu)',
                    '🔓 <code>voices_write</code> — dodawanie głosów z public library do "My Voices" (przycisk "+ Dodaj do moich")',
                    '🔓 <code>models_read</code> — pobranie listy modeli TTS i STT (↻ w ustawieniach)',
                    '🔓 <code>text_to_speech</code> — synteza mowy (PODSTAWA — bez tego nie wygenerujesz lektora)',
                    '🔓 <code>sound_generation</code> — generowanie SFX (Text-to-Sound-Effects, 0.5-22s)',
                    '🔓 <code>music_generation</code> — Eleven Music (generowanie utworów z opcjonalnymi wokalami)',
                    '🔓 <code>speech_to_text</code> — transkrypcja Scribe v2 (potrzebne dla word-level captions)',
                    '🔓 <code>user_read</code> — odczyt limitów konta (pokazuje pozostałą kwotę znaków)',
                    '🔓 <code>shared_voices_read</code> (alias: voice_library_read) — przeszukiwanie publicznej biblioteki głosów',
                    '<i>Opcjonalne:</i>',
                    '🔒 <code>history_read / history_write</code> — odczyt/zapis historii generowanych próbek (do debugowania)',
                    '🔒 <code>voices_admin</code> — zarządzanie własnymi voice clones (tylko gdy chcesz klonować przez API)',
                    '<b>Najprościej:</b> "Has access to all" — wtedy wszystkie powyższe są zaznaczone automatycznie.'
                ],
                en: [
                    '<b>Scopes you MUST tick in the "Access" section (when creating the key):</b>',
                    '🔓 <code>voices_read</code> — read "My Voices" list (required for 📋 voice picker)',
                    '🔓 <code>voices_write</code> — add public-library voices to "My Voices" ("+ Add to my voices" button)',
                    '🔓 <code>models_read</code> — fetch the TTS and STT model list (↻ in settings)',
                    '🔓 <code>text_to_speech</code> — speech synthesis (CORE — without this you cannot generate voiceover)',
                    '🔓 <code>sound_generation</code> — SFX generation (Text-to-Sound-Effects, 0.5-22s)',
                    '🔓 <code>music_generation</code> — Eleven Music (full songs with optional vocals)',
                    '🔓 <code>speech_to_text</code> — Scribe v2 transcription (required for word-level captions)',
                    '🔓 <code>user_read</code> — read account quotas (shows remaining character allowance)',
                    '🔓 <code>shared_voices_read</code> (alias: voice_library_read) — browse the public voice library',
                    '<i>Optional:</i>',
                    '🔒 <code>history_read / history_write</code> — read/write generation history (for debugging)',
                    '🔒 <code>voices_admin</code> — manage your own voice clones (only if you want to clone via API)',
                    '<b>Simplest:</b> "Has access to all" — all of the above are ticked automatically.'
                ]
            },
            troubleshoot: {
                pl: [
                    '<b>"missing_permissions" / "voices_read"</b>: klucz nie ma scope\'a <code>voices_read</code> — wygeneruj nowy klucz lub w istniejącym kliknij <b>"Edit"</b> i zaznacz brakujący scope.',
                    '<b>"missing_permissions" / "models_read"</b>: brak <code>models_read</code> — analogicznie, edytuj klucz i dodaj scope.',
                    '<b>401 unauthorized</b>: klucz wygasł, został cofnięty lub źle przepisany — wygeneruj nowy.',
                    '<b>quota_exceeded</b>: zużyłeś miesięczny limit znaków — upgrade plan lub poczekaj do reset (zwykle 1. dnia miesiąca).',
                    '<b>voice_not_found</b>: głos z public library musisz najpierw "Dodać do moich" (przycisk + w 📋 modal) — wymaga <code>voices_write</code>.',
                    '<b>403 forbidden na text-to-speech</b>: brak <code>text_to_speech</code> scope\'a (rzadkie, default jest aktywny).',
                    '<b>SFX zwraca błąd</b>: brak <code>sound_generation</code> scope\'a — wyedytuj klucz i dodaj scope. Sprawdź też czy nie przekroczyłeś limitu długości (max 22s).',
                    '<b>Eleven Music zwraca błąd</b>: brak <code>music_generation</code> scope\'a LUB Eleven Music jeszcze nie dostępne w Twoim planie/regionie (niektóre konta są na liście oczekujących).',
                    '<b>STT zwraca błąd</b>: brak <code>speech_to_text</code> scope\'a, lub model nie jest dostępny w Twoim planie.'
                ],
                en: [
                    '<b>"missing_permissions" / "voices_read"</b>: key lacks the <code>voices_read</code> scope — generate a new key or click <b>"Edit"</b> on the existing one and tick the missing scope.',
                    '<b>"missing_permissions" / "models_read"</b>: missing <code>models_read</code> — same fix, edit the key and add the scope.',
                    '<b>401 unauthorized</b>: key expired, revoked, or mistyped — generate a new one.',
                    '<b>quota_exceeded</b>: monthly character limit hit — upgrade or wait for reset (typically the 1st of the month).',
                    '<b>voice_not_found</b>: public-library voices must first be added to "My Voices" (+ button in 📋 modal) — requires <code>voices_write</code>.',
                    '<b>403 forbidden on text-to-speech</b>: missing <code>text_to_speech</code> scope (rare; default is active).',
                    '<b>SFX errors out</b>: missing <code>sound_generation</code> scope — edit the key and add the scope. Also check duration limit (max 22s).',
                    '<b>Eleven Music errors out</b>: missing <code>music_generation</code> scope OR Eleven Music not yet enabled on your plan/region (some accounts are waitlisted).',
                    '<b>STT errors out</b>: missing <code>speech_to_text</code> scope, or the model is not available on your plan.'
                ]
            }
        },
        replicate: {
            icon: '🎬',
            title: { pl: 'Replicate API (Grok Video)', en: 'Replicate API (Grok Video)' },
            intro: {
                pl: 'Replicate hostuje modele generatywne na GPU — używamy go do <b>xAI Grok Imagine Video</b> (image-to-video). Klucz potrzebny tylko jeśli chcesz generować wideo.',
                en: 'Replicate hosts generative models on GPU — we use <b>xAI Grok Imagine Video</b> (image-to-video). Key needed only if you want video generation.'
            },
            steps: [
                { pl: 'Załóż konto na <a href="https://replicate.com/signin" target="_blank">replicate.com</a> (GitHub / Google).', en: 'Sign up at <a href="https://replicate.com/signin" target="_blank">replicate.com</a> (GitHub / Google).' },
                { pl: 'Dodaj kartę płatniczą (wymagane do uruchamiania prediction): <a href="https://replicate.com/account/billing" target="_blank">replicate.com/account/billing</a>. Możesz też ustawić <b>monthly spend cap</b> (np. $20/mies) jako bezpiecznik.', en: 'Add a payment card (required to run predictions): <a href="https://replicate.com/account/billing" target="_blank">replicate.com/account/billing</a>. You can also set a <b>monthly spend cap</b> (e.g. $20/mo) as a safeguard.' },
                { pl: 'Wygeneruj token: <a href="https://replicate.com/account/api-tokens" target="_blank">replicate.com/account/api-tokens</a> → <b>"Create token"</b>. Token nazywa się np. <code>afterALL</code>.', en: 'Generate a token: <a href="https://replicate.com/account/api-tokens" target="_blank">replicate.com/account/api-tokens</a> → <b>"Create token"</b>. Name it e.g. <code>afterALL</code>.' },
                { pl: 'Replicate <b>NIE</b> ma scope\'ów per-endpoint — token daje pełen dostęp do API (predictions create/get/cancel, models, files). Możesz mieć wiele tokenów per konto i odwoływać je niezależnie.', en: 'Replicate has <b>NO</b> per-endpoint scopes — the token grants full API access (predictions create/get/cancel, models, files). You can have multiple tokens per account and revoke them independently.' },
                { pl: 'Skopiuj token (<code>r8_...</code>) i wklej w polu <b>"Klucz Replicate API"</b>. Token jest pokazany w pełni — możesz go skopiować ponownie później.', en: 'Copy the token (<code>r8_...</code>) and paste it into <b>"Replicate API Key"</b>. The token remains visible — you can copy it again later.' }
            ],
            link: 'https://replicate.com/account/api-tokens',
            pricing: {
                pl: 'Grok Imagine Video: ~$0,15-0,40 za 5s wideo (zależy od rozdzielczości). Pay-as-you-go.',
                en: 'Grok Imagine Video: ~$0.15-0.40 per 5s clip (depends on resolution). Pay-as-you-go.'
            },
            usage: {
                pl: ['Generowanie krótkich wideo (image-to-video, 3-10s)', 'Możliwość użycia innych modeli Replicate przez Custom Secrets'],
                en: ['Short video generation (image-to-video, 3-10s)', 'Other Replicate models possible via Custom Secrets']
            },
            troubleshoot: {
                pl: ['<b>402 Payment required</b>: musisz dodać kartę.', '<b>429 Rate limit</b>: zbyt wiele zapytań — odczekaj.', '<b>Long pending</b>: GPU kolejka — niektóre modele mają długi cold-start (~30s).'],
                en: ['<b>402 Payment required</b>: add a card first.', '<b>429 Rate limit</b>: too many requests — wait.', '<b>Long pending</b>: GPU queue — some models have a ~30s cold start.']
            }
        },
        lmstudio: {
            icon: '💻',
            title: { pl: 'LM Studio (Lokalnie)', en: 'LM Studio (Local)' },
            intro: {
                pl: 'LM Studio to bezpłatna desktopowa aplikacja, która uruchamia modele LLM lokalnie na Twoim GPU/CPU. Zero opłat, pełna prywatność. Wymaga przyzwoitego sprzętu (16+ GB RAM/VRAM).',
                en: 'LM Studio is a free desktop app that runs LLMs locally on your GPU/CPU. No fees, full privacy. Requires decent hardware (16+ GB RAM/VRAM).'
            },
            steps: [
                { pl: 'Pobierz LM Studio z <a href="https://lmstudio.ai/" target="_blank">lmstudio.ai</a> (Windows / macOS / Linux).', en: 'Download LM Studio from <a href="https://lmstudio.ai/" target="_blank">lmstudio.ai</a> (Windows / macOS / Linux).' },
                { pl: 'Po instalacji wyszukaj i pobierz model (np. <b>Qwen 2.5 14B Instruct</b>, <b>Llama 3.1 8B</b>) w zakładce Discover.', en: 'After install, search and download a model (e.g. <b>Qwen 2.5 14B Instruct</b>, <b>Llama 3.1 8B</b>) in the Discover tab.' },
                { pl: 'Przejdź do <b>Developer</b> → włącz <b>"Local Server"</b> (Status: Running, port 1234 domyślny).', en: 'Go to <b>Developer</b> → enable <b>"Local Server"</b> (Status: Running, default port 1234).' },
                { pl: 'Załaduj model w panelu Server (Load Model).', en: 'Load a model in the Server panel (Load Model).' },
                { pl: 'W ustawieniach wtyczki: Dostawcy LLM → <b>LM Studio</b>, URL: <code>http://localhost:1234</code>, kliknij ↻ aby pobrać listę.', en: 'In plugin settings: LLM Providers → <b>LM Studio</b>, URL: <code>http://localhost:1234</code>, click ↻ to fetch the list.' }
            ],
            link: 'https://lmstudio.ai/',
            pricing: {
                pl: 'BEZPŁATNE w 100%. Koszt: prąd + sprzęt (GPU NVIDIA z 8+ GB VRAM zalecane).',
                en: '100% FREE. Cost: electricity + hardware (NVIDIA GPU with 8+ GB VRAM recommended).'
            },
            usage: {
                pl: ['Główna logika agenta lokalnie (zero cloud)', 'Brak telemetrii — pełna prywatność', 'Brak limitów API (tylko sprzętowe)'],
                en: ['Main agent logic locally (zero cloud)', 'No telemetry — full privacy', 'No API limits (only hardware)']
            },
            troubleshoot: {
                pl: ['<b>"Nie udało się połączyć"</b>: sprawdź czy serwer w LM Studio jest uruchomiony (status Running w Developer).', '<b>Bardzo wolny output</b>: model jest za duży dla Twojego GPU — wybierz mniejszy (7B-13B) lub kwantyzowany (Q4_K_M).', '<b>OutOfMemory</b>: zwolnij VRAM (zamknij inne apps GPU) lub użyj CPU offload w LM Studio.'],
                en: ['<b>"Cannot connect"</b>: check LM Studio server is running (Developer → Status: Running).', '<b>Very slow output</b>: model too big for your GPU — pick smaller (7B-13B) or quantized (Q4_K_M).', '<b>OutOfMemory</b>: free VRAM (close other GPU apps) or enable CPU offload in LM Studio.']
            }
        },
        custom: {
            icon: '🔑',
            title: { pl: 'Custom API Keys (inne usługi)', en: 'Custom API Keys (other services)' },
            intro: {
                pl: 'Sekcja dla dowolnych innych kluczy API, których agent może użyć w skryptach Python (np. OpenAI, Anthropic direct, HuggingFace, Stability, ComfyUI cloud). Klucze są dostępne dla agenta w skryptach Python przez nazwę.',
                en: 'Section for any other API keys the agent might use in Python scripts (e.g. OpenAI, Anthropic direct, HuggingFace, Stability, ComfyUI cloud). Keys are exposed to the agent by name.'
            },
            steps: [
                { pl: 'Wprowadź nazwę usługi (np. "OpenAI", "HuggingFace") — bez spacji ani znaków specjalnych.', en: 'Enter the service name (e.g. "OpenAI", "HuggingFace") — no spaces or special chars.' },
                { pl: 'Wklej klucz API z konta danej usługi.', en: 'Paste the API key from your account on that service.' },
                { pl: 'Kliknij <b>+</b>. Klucz pojawi się w liście. Agent zobaczy nazwy w swojej pamięci kontekstowej i może wywołać je przez Python (<code>os.environ</code>) lub HTTP requesty.', en: 'Click <b>+</b>. The key appears in the list. The agent will see names in its context memory and can use them via Python (<code>os.environ</code>) or HTTP requests.' }
            ],
            usage: {
                pl: ['Integracje z dowolnym REST API w skryptach Python', 'Klonowanie repo prywatnego (token GitHub)', 'Dostęp do alternatywnych dostawców LLM'],
                en: ['Integration with any REST API in Python scripts', 'Cloning private repos (GitHub token)', 'Access to alternative LLM providers']
            }
        }
    };

    const apiHelpOverlay = document.getElementById('api-help-overlay');
    const apiHelpTitle = document.getElementById('api-help-title');
    const apiHelpBody = document.getElementById('api-help-body');
    const closeApiHelpBtn = document.getElementById('close-api-help');
    const apiHelpCloseBtn = document.getElementById('api-help-close-btn');

    function openApiHelp(apiName) {
        const data = apiHelpContent[apiName];
        if (!data || !apiHelpOverlay) return;
        const lang = _activeLang;
        const pick = (obj) => (obj && (obj[lang] || obj.en || obj.pl)) || '';
        const pickList = (obj) => {
            const arr = obj && (obj[lang] || obj.en || obj.pl);
            return Array.isArray(arr) ? arr : [];
        };
        apiHelpTitle.innerHTML = (data.icon || '') + ' ' + pick(data.title);

        let html = '<div class="api-help-intro">' + pick(data.intro) + '</div>';
        if (data.steps && data.steps.length) {
            html += '<div class="api-help-section"><h3>' + tr('api-help-steps-title') + '</h3><ol class="api-help-steps">';
            data.steps.forEach(s => { html += '<li>' + pick(s) + '</li>'; });
            html += '</ol></div>';
        }
        if (data.link) {
            html += '<div class="api-help-section"><a href="' + data.link + '" target="_blank" class="tool-form-btn primary" style="display:inline-block; text-decoration:none;">🔗 ' + tr('api-help-open-link') + '</a></div>';
        }
        const usageList = pickList(data.usage);
        if (usageList.length) {
            html += '<div class="api-help-section"><h3>' + tr('api-help-usage') + '</h3><ul class="api-help-list">';
            usageList.forEach(u => { html += '<li>' + u + '</li>'; });
            html += '</ul></div>';
        }
        if (data.pricing) {
            html += '<div class="api-help-section"><h3>' + tr('api-help-pricing') + '</h3><div style="font-size:12px; color:var(--text-secondary); padding:0.4rem; background:rgba(0,0,0,0.18); border-radius:6px;">' + pick(data.pricing) + '</div></div>';
        }
        const tsList = pickList(data.troubleshoot);
        if (tsList.length) {
            html += '<div class="api-help-section"><h3>' + tr('api-help-troubleshoot') + '</h3><ul class="api-help-list">';
            tsList.forEach(t => { html += '<li>' + t + '</li>'; });
            html += '</ul></div>';
        }
        apiHelpBody.innerHTML = html;

        // Intercept link clicks to open in OS browser via CSInterface (Adobe AE doesn't open new tabs natively)
        apiHelpBody.querySelectorAll('a[target="_blank"]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                try {
                    const csi = new CSInterface();
                    csi.openURLInDefaultBrowser(a.getAttribute('href'));
                } catch (_) { window.open(a.getAttribute('href'), '_blank'); }
            });
        });

        apiHelpOverlay.classList.remove('hidden');
    }
    function closeApiHelp() {
        if (apiHelpOverlay) apiHelpOverlay.classList.add('hidden');
    }
    // Wire close handlers
    if (closeApiHelpBtn) closeApiHelpBtn.addEventListener('click', closeApiHelp);
    if (apiHelpCloseBtn) apiHelpCloseBtn.addEventListener('click', closeApiHelp);
    // Wire all help-icon buttons (delegated)
    document.addEventListener('click', (e) => {
        const helpBtn = e.target.closest('[data-api-help]');
        if (helpBtn) { openApiHelp(helpBtn.getAttribute('data-api-help')); }
    });

    // ===== ElevenLabs UI hookup ========================================
    const ttsProviderSelect = document.getElementById('tts-provider-select');
    const sttProviderSelect = document.getElementById('stt-provider-select');
    const musicProviderSelect = document.getElementById('music-provider-select');
    const sfxInfluence = document.getElementById('sfx-influence');
    const sfxInfluenceVal = document.getElementById('sfx-influence-val');
    const sfxDefaultDuration = document.getElementById('sfx-default-duration');
    const elMusicInstr = document.getElementById('el-music-instr');
    const ttsModelSelect2 = document.getElementById('ttsmodel-select-2');
    const elModelSelect = document.getElementById('elevenlabs-model-select');
    const elModelInfo = document.getElementById('elevenlabs-model-info');
    const elSttModelSelect = document.getElementById('elevenlabs-stt-model-select');
    const elOutputFormat = document.getElementById('elevenlabs-output-format');
    const elStability = document.getElementById('el-stability');
    const elSimilarity = document.getElementById('el-similarity');
    const elStyle = document.getElementById('el-style');
    const elSpeakerBoost = document.getElementById('el-speaker-boost');
    const elStabilityVal = document.getElementById('el-stability-val');
    const elSimilarityVal = document.getElementById('el-similarity-val');
    const elStyleVal = document.getElementById('el-style-val');
    const elUseGeneralDefault = document.getElementById('el-use-general-default');
    const elDefaultVoiceInput = document.getElementById('el-default-voice');
    const elMaleVoiceInput = document.getElementById('el-male-voice');
    const elFemaleVoiceInput = document.getElementById('el-female-voice');
    const elDefaultDisplay = document.getElementById('el-default-voice-display');
    const elMaleDisplay = document.getElementById('el-male-voice-display');
    const elFemaleDisplay = document.getElementById('el-female-voice-display');

    function setVoiceDisplay(target, voiceObj) {
        const map = { default: elDefaultDisplay, male: elMaleDisplay, female: elFemaleDisplay };
        const input = { default: elDefaultVoiceInput, male: elMaleVoiceInput, female: elFemaleVoiceInput };
        const display = map[target];
        const inputEl = input[target];
        if (!display || !inputEl) return;
        if (!voiceObj || !voiceObj.voice_id) {
            display.textContent = '— niewybrany —';
            display.classList.remove('has-voice');
            inputEl.value = '';
        } else {
            const meta = [voiceObj.gender, voiceObj.age, voiceObj.accent].filter(Boolean).join(' · ');
            display.innerHTML = '<strong>' + escapeAttr(voiceObj.name) + '</strong>'
                + (meta ? ' <span style="color:var(--text-secondary);font-size:10px;">' + escapeAttr(meta) + '</span>' : '');
            display.classList.add('has-voice');
            display.dataset.voiceId = voiceObj.voice_id;
            inputEl.value = voiceObj.voice_id;
        }
    }
    function escapeAttr(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function initElevenLabsUI() {
        if (ttsProviderSelect) ttsProviderSelect.value = agent.ttsProvider || 'gemini';
        if (sttProviderSelect) sttProviderSelect.value = agent.sttProvider || 'elevenlabs';
        if (musicProviderSelect) musicProviderSelect.value = agent.musicProvider || 'gemini';
        if (elOutputFormat) elOutputFormat.value = agent.elevenlabsOutputFormat || 'mp3_44100_128';
        if (elSttModelSelect) elSttModelSelect.value = agent.elevenlabsSttModel || 'scribe_v2';
        // SFX defaults
        if (sfxInfluence) {
            const v = (agent.elevenlabsSfxPromptInfluence != null) ? agent.elevenlabsSfxPromptInfluence : 0.3;
            sfxInfluence.value = v;
            if (sfxInfluenceVal) sfxInfluenceVal.textContent = (+v).toFixed(2);
        }
        if (sfxDefaultDuration) sfxDefaultDuration.value = agent.elevenlabsSfxDefaultDuration || 0;
        if (elMusicInstr) elMusicInstr.checked = !!agent.elevenlabsMusicForceInstrumental;
        // Voice settings
        const vs = agent.elevenlabsVoiceSettings || {};
        if (elStability) { elStability.value = vs.stability != null ? vs.stability : 0.5; elStabilityVal.textContent = (+elStability.value).toFixed(2); }
        if (elSimilarity) { elSimilarity.value = vs.similarity_boost != null ? vs.similarity_boost : 0.75; elSimilarityVal.textContent = (+elSimilarity.value).toFixed(2); }
        if (elStyle) { elStyle.value = vs.style != null ? vs.style : 0; elStyleVal.textContent = (+elStyle.value).toFixed(2); }
        if (elSpeakerBoost) elSpeakerBoost.checked = vs.use_speaker_boost !== false;
        if (elUseGeneralDefault) elUseGeneralDefault.checked = !!agent.elevenlabsUseGeneralDefault;
        // Voice IDs (display will be filled async if we have them)
        setVoiceDisplay('default', agent.elevenlabsDefaultVoice ? { voice_id: agent.elevenlabsDefaultVoice, name: 'voice:' + agent.elevenlabsDefaultVoice.substring(0, 8) } : null);
        setVoiceDisplay('male', agent.elevenlabsMaleVoice ? { voice_id: agent.elevenlabsMaleVoice, name: 'voice:' + agent.elevenlabsMaleVoice.substring(0, 8) } : null);
        setVoiceDisplay('female', agent.elevenlabsFemaleVoice ? { voice_id: agent.elevenlabsFemaleVoice, name: 'voice:' + agent.elevenlabsFemaleVoice.substring(0, 8) } : null);
        // Update display labels with proper names if possible
        if (agent.elevenlabsApiKey) hydrateVoiceDisplays();
        // TTS provider toggle visibility
        updateTtsProviderVisibility();
    }
    async function hydrateVoiceDisplays() {
        try {
            const ELClient = window.AfterAllElevenLabs;
            if (!ELClient || !agent.elevenlabsApiKey) return;
            const client = new ELClient({ apiKey: agent.elevenlabsApiKey });
            const userVoices = await client.listUserVoices(false);
            const byId = {};
            userVoices.forEach(v => { byId[v.voice_id] = v; });
            ['default', 'male', 'female'].forEach(t => {
                const inputId = t === 'default' ? agent.elevenlabsDefaultVoice
                              : t === 'male' ? agent.elevenlabsMaleVoice
                              : agent.elevenlabsFemaleVoice;
                if (inputId && byId[inputId]) setVoiceDisplay(t, byId[inputId]);
            });
        } catch (e) {
            // Quietly note permission errors only once
            if (/missing_permissions/i.test(e.message) && !window._hexartVoiceWarned) {
                window._hexartVoiceWarned = true;
                addLog('ElevenLabs voice hydrate: klucz API bez uprawnienia voices_read (informacja jednorazowa).', 'info');
            } else if (!/missing_permissions/i.test(e.message)) {
                addLog('Voice hydrate: ' + e.message, 'info');
            }
        }
    }
    function updateTtsProviderVisibility() {
        const v = (ttsProviderSelect && ttsProviderSelect.value) || agent.ttsProvider || 'gemini';
        document.querySelectorAll('.provider-config[data-tts-provider]').forEach(div => {
            div.classList.toggle('hidden', div.getAttribute('data-tts-provider') !== v);
        });
        const voiceCard = document.getElementById('elevenlabs-voice-card');
        if (voiceCard) voiceCard.style.display = (v === 'elevenlabs') ? '' : 'none';
    }
    if (ttsProviderSelect) ttsProviderSelect.addEventListener('change', updateTtsProviderVisibility);
    // Sync slider values to label
    [
        [elStability, elStabilityVal],
        [elSimilarity, elSimilarityVal],
        [elStyle, elStyleVal],
        [sfxInfluence, sfxInfluenceVal]
    ].forEach(([sl, lbl]) => {
        if (sl && lbl) sl.addEventListener('input', () => { lbl.textContent = (+sl.value).toFixed(2); });
    });

    async function loadElevenLabsModels(force) {
        if (!agent.elevenlabsApiKey) {
            elModelSelect.innerHTML = '<option value="">⚠ Brak klucza ElevenLabs</option>';
            return;
        }
        try {
            const ELClient = window.AfterAllElevenLabs;
            const client = new ELClient({ apiKey: agent.elevenlabsApiKey });
            addLog('Pobieram modele ElevenLabs...', 'info');
            const list = await client.listModels(!!force);
            const ttsList = list.filter(m => m.canDoTTS);
            const sttList = list.filter(m => m.canDoSTT);
            elModelSelect.innerHTML = '';
            const trim = s => (s && s.length > 30) ? (s.substring(0, 28) + '…') : (s || '');
            ttsList.forEach(m => {
                const o = document.createElement('option');
                o.value = m.id;
                o.textContent = trim(m.name || m.id);
                o.title = (m.name ? m.name + ' · ' : '') + m.id + (m.description ? ' — ' + m.description : '');
                elModelSelect.appendChild(o);
            });
            if (agent.elevenlabsModel && ttsList.find(m => m.id === agent.elevenlabsModel)) {
                elModelSelect.value = agent.elevenlabsModel;
            }
            // Refresh STT models if present
            if (sttList.length > 0) {
                elSttModelSelect.innerHTML = '';
                sttList.forEach(m => {
                    const o = document.createElement('option');
                    o.value = m.id;
                    o.textContent = trim(m.name || m.id);
                    o.title = (m.name ? m.name + ' · ' : '') + m.id;
                    elSttModelSelect.appendChild(o);
                });
                if (agent.elevenlabsSttModel && sttList.find(m => m.id === agent.elevenlabsSttModel)) {
                    elSttModelSelect.value = agent.elevenlabsSttModel;
                }
            }
            const selModel = ttsList.find(m => m.id === elModelSelect.value);
            if (selModel) {
                elModelInfo.textContent = selModel.description + ' | Maks. znaków: ' + (selModel.maxCharsSub || selModel.maxCharsFree || '?');
            }
            addLog('ElevenLabs: ' + ttsList.length + ' modeli TTS, ' + sttList.length + ' STT.', 'success');
        } catch (e) {
            addLog('ElevenLabs models error: ' + e.message, 'error');
            let label = 'Błąd: ' + e.message.substring(0, 60);
            if (/missing_permissions/i.test(e.message) || /models_read/i.test(e.message)) {
                label = '⚠ Klucz API bez uprawnień models_read';
                // Toast hint
                appendMessage('system', tr('sysmsg-el-no-permissions'));
            }
            elModelSelect.innerHTML = '<option value="">' + label + '</option>';
        }
    }
    const refreshElevenLabsBtn = document.getElementById('refresh-elevenlabs-models');
    if (refreshElevenLabsBtn) refreshElevenLabsBtn.addEventListener('click', () => loadElevenLabsModels(true));

    // ===== Voice Library / Discovery Modal =============================
    const voicePickerOverlay = document.getElementById('voice-picker-overlay');
    const voicePickerList = document.getElementById('voice-picker-list');
    const voicePickerStatus = document.getElementById('voice-picker-status');
    const voicePickerTitle = document.getElementById('voice-picker-title');
    const vpSearch = document.getElementById('vp-search');
    const vpSource = document.getElementById('vp-source');
    const vpSort = document.getElementById('vp-sort');
    const vpGender = document.getElementById('vp-gender');
    const vpAge = document.getElementById('vp-age');
    const vpAccent = document.getElementById('vp-accent');
    const vpUseCase = document.getElementById('vp-use-case');
    let voicePickerTarget = 'default';   // 'default' | 'male' | 'female'
    let voicePickerSelectedVoice = null;
    let voicePickerCache = [];
    let voicePickerCurrentPreviewAudio = null;

    function openVoicePicker(target) {
        if (!agent.elevenlabsApiKey) {
            appendMessage('system', tr('sysmsg-el-key-needed'));
            return;
        }
        voicePickerTarget = target;
        voicePickerSelectedVoice = null;
        // Lock the gender filter when picking male/female default
        if (target === 'male') {
            vpGender.value = 'male'; vpGender.disabled = true;
            voicePickerTitle.textContent = tr('voice-picker-title-male');
        } else if (target === 'female') {
            vpGender.value = 'female'; vpGender.disabled = true;
            voicePickerTitle.textContent = tr('voice-picker-title-female');
        } else {
            vpGender.disabled = false;
            voicePickerTitle.textContent = tr('voice-picker-title-default');
        }
        voicePickerOverlay.classList.remove('hidden');
        if (voicePickerCache.length === 0) loadVoicePicker();
        else renderVoicePicker();
    }
    async function loadVoicePicker() {
        try {
            voicePickerStatus.textContent = 'Pobieram głosy z ElevenLabs...';
            voicePickerList.innerHTML = '';
            const ELClient = window.AfterAllElevenLabs;
            const client = new ELClient({ apiKey: agent.elevenlabsApiKey });
            const source = vpSource.value;
            let list = [];
            if (source === 'user') {
                list = await client.listUserVoices(true);
            } else {
                // Public library search — pass filters
                list = await client.searchVoiceLibrary({
                    gender: vpGender.value || undefined,
                    age: vpAge.value || undefined,
                    accent: vpAccent.value || undefined,
                    use_case: vpUseCase.value || undefined,
                    search: vpSearch.value || undefined,
                    sort: vpSort.value || undefined,
                    page_size: 100
                });
            }
            voicePickerCache = list;
            voicePickerStatus.textContent = 'Znaleziono ' + list.length + ' głosów.';
            renderVoicePicker();
        } catch (e) {
            let msg = 'Błąd: ' + e.message;
            if (/missing_permissions/i.test(e.message) || /voices_read/i.test(e.message)) {
                msg = '⚠ Klucz ElevenLabs nie ma uprawnienia voices_read — wygeneruj nowy z All permissions na elevenlabs.io/app/settings/api-keys';
            }
            voicePickerStatus.textContent = msg;
            addLog('Voice library error: ' + e.message, 'error');
        }
    }
    function renderVoicePicker() {
        let filtered = voicePickerCache.slice();
        // Local filters work on user voices too (library uses server-side filters)
        const src = vpSource.value;
        if (src === 'user') {
            if (vpGender.value) filtered = filtered.filter(v => (v.gender || '').includes(vpGender.value));
            if (vpAge.value) filtered = filtered.filter(v => (v.age || '').includes(vpAge.value));
            if (vpAccent.value) filtered = filtered.filter(v => (v.accent || '').includes(vpAccent.value));
            if (vpUseCase.value) filtered = filtered.filter(v => (v.useCase || '').includes(vpUseCase.value));
            const q = (vpSearch.value || '').toLowerCase().trim();
            if (q) filtered = filtered.filter(v => (v.name + ' ' + v.description).toLowerCase().indexOf(q) !== -1);
        }
        // Enforce gender filter when locked
        if (voicePickerTarget === 'male') filtered = filtered.filter(v => (v.gender || '').toLowerCase().indexOf('male') === 0 || (v.gender === 'male'));
        if (voicePickerTarget === 'female') filtered = filtered.filter(v => (v.gender || '').toLowerCase().indexOf('female') === 0);
        voicePickerList.innerHTML = '';
        if (filtered.length === 0) {
            voicePickerList.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-secondary);">Brak głosów pasujących do filtrów. Spróbuj zmienić kryteria lub załaduj inne źródło.</div>';
            return;
        }
        voicePickerStatus.textContent = 'Pokazano ' + filtered.length + ' głosów.';
        filtered.slice(0, 200).forEach(v => {
            const row = document.createElement('div');
            row.className = 'voice-row';
            const meta = [v.gender, v.age, v.accent, v.useCase].filter(Boolean).join(' · ');
            const isUser = v.source === 'user';
            row.innerHTML = `
                <div class="voice-row-head">
                    <div class="voice-row-name">${escapeAttr(v.name)} ${isUser ? '<span class="badge feat">Moja</span>' : ''}</div>
                    <div class="voice-row-id">${escapeAttr(v.voice_id)}</div>
                </div>
                <div class="voice-row-meta">${escapeAttr(meta) || '<span style="opacity:0.6;">brak metadanych</span>'}</div>
                ${v.description ? '<div class="voice-row-desc">' + escapeAttr(v.description.substring(0, 200)) + '</div>' : ''}
                <div class="voice-row-actions">
                    ${v.preview_url ? '<button class="mini-btn voice-preview" data-preview="' + escapeAttr(v.preview_url) + '">▶ Preview</button>' : ''}
                    ${!isUser && v.public_owner_id ? '<button class="mini-btn voice-add">+ Dodaj do moich</button>' : ''}
                </div>
            `;
            row.addEventListener('click', () => {
                voicePickerSelectedVoice = v;
                Array.from(voicePickerList.children).forEach(c => c.classList.remove('picked'));
                row.classList.add('picked');
            });
            const previewBtn = row.querySelector('.voice-preview');
            if (previewBtn) previewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (voicePickerCurrentPreviewAudio) {
                    voicePickerCurrentPreviewAudio.pause();
                    voicePickerCurrentPreviewAudio = null;
                }
                const audio = new Audio(previewBtn.getAttribute('data-preview'));
                voicePickerCurrentPreviewAudio = audio;
                audio.play().catch(err => addLog('Audio preview error: ' + err.message, 'warning'));
            });
            const addBtn = row.querySelector('.voice-add');
            if (addBtn) addBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    addBtn.textContent = '...'; addBtn.disabled = true;
                    const ELClient = window.AfterAllElevenLabs;
                    const client = new ELClient({ apiKey: agent.elevenlabsApiKey });
                    await client.addSharedVoice(v.public_owner_id, v.voice_id, v.name);
                    addBtn.textContent = '✓ Dodano';
                    addLog(tr('log-voice-added').replace('{name}', v.name), 'success');
                } catch (err) {
                    addBtn.textContent = '✕ Błąd'; addBtn.disabled = false;
                    addLog('Voice add error: ' + err.message, 'error');
                }
            });
            voicePickerList.appendChild(row);
        });
    }
    [vpSearch, vpSource, vpSort, vpGender, vpAge, vpAccent, vpUseCase].forEach(el => {
        if (!el) return;
        // For library searches, trigger a reload; for user voices, just re-filter locally.
        const reload = () => { if (vpSource.value === 'library') loadVoicePicker(); else renderVoicePicker(); };
        el.addEventListener('change', reload);
        if (el === vpSearch) el.addEventListener('input', () => { if (vpSource.value === 'user') renderVoicePicker(); });
    });
    const closeVoicePicker = document.getElementById('close-voice-picker');
    if (closeVoicePicker) closeVoicePicker.addEventListener('click', () => {
        if (voicePickerCurrentPreviewAudio) { voicePickerCurrentPreviewAudio.pause(); voicePickerCurrentPreviewAudio = null; }
        voicePickerOverlay.classList.add('hidden');
    });
    const reloadVoiceBtn = document.getElementById('reload-voice-list');
    if (reloadVoiceBtn) reloadVoiceBtn.addEventListener('click', () => loadVoicePicker());
    const applyVoiceBtn = document.getElementById('apply-voice-pick');
    if (applyVoiceBtn) applyVoiceBtn.addEventListener('click', () => {
        if (!voicePickerSelectedVoice) { addLog(tr('log-voice-pick-empty'), 'warning'); return; }
        setVoiceDisplay(voicePickerTarget, voicePickerSelectedVoice);
        addLog(tr('log-voice-selected-as').replace('{name}', voicePickerSelectedVoice.name).replace('{target}', voicePickerTarget), 'success');
        if (voicePickerCurrentPreviewAudio) { voicePickerCurrentPreviewAudio.pause(); voicePickerCurrentPreviewAudio = null; }
        voicePickerOverlay.classList.add('hidden');
    });
    // Hook the voice picker open buttons (per target)
    document.querySelectorAll('[data-pick-voice]').forEach(btn => {
        btn.addEventListener('click', () => openVoicePicker(btn.getAttribute('data-pick-voice')));
    });
    document.querySelectorAll('[data-clear-voice]').forEach(btn => {
        btn.addEventListener('click', () => setVoiceDisplay(btn.getAttribute('data-clear-voice'), null));
    });

    // ===== Feature flags / Tools UI ====================================
    const featureFlagsList = document.getElementById('feature-flags-list');
    const toolsQuickList = document.getElementById('tools-quick-list');
    const featureLabels = {
        imageGen: { label: '🖼 Generator Obrazów', desc: 'Gemini / OpenRouter — text-to-image' },
        imageEdit: { label: '✂ Edytor Obrazów', desc: 'Edycja / inpainting istniejących obrazów' },
        videoGen: { label: '🎬 Generator Wideo (Grok)', desc: 'Replicate image-to-video' },
        ttsGen: { label: '🎙 TTS (Generator Lektora)', desc: 'Gemini lub ElevenLabs' },
        sttGen: { label: '📝 Speech-to-Text', desc: 'ElevenLabs Scribe lub WhisperX' },
        musicGen: { label: '🎵 Generator Muzyki', desc: 'Gemini Lyria 3 Pro lub ElevenLabs Eleven Music' },
        sfxGen: { label: '🔊 Efekty Dźwiękowe (SFX)', desc: 'ElevenLabs Text-to-Sound-Effects (0.5–22s)' },
        svgGen: { label: '✦ Generator SVG', desc: 'Wektorowa grafika przez LLM' },
        grounding: { label: '🌐 Google Search Grounding', desc: 'Live web (Gemini only)' },
        renderPreview: { label: '📷 Render Preview', desc: 'Multi-frame podgląd dla Vision' },
        pythonTools: { label: '🐍 Środowiska Python', desc: 'venv + pip + skille' }
    };
    function renderFeatureFlagsUI() {
        if (!featureFlagsList) return;
        featureFlagsList.innerHTML = '';
        Object.keys(featureLabels).forEach(key => {
            const meta = featureLabels[key];
            const enabled = agent.isFeatureEnabled(key);
            const row = document.createElement('div');
            row.className = 'feature-row';
            row.innerHTML = `
                <label class="toggle-switch">
                    <input type="checkbox" data-feature="${key}" ${enabled ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
                <div style="flex:1;">
                    <div style="font-size: 12px; font-weight: 500;">${meta.label}</div>
                    <div style="font-size: 10px; color: var(--text-secondary);">${meta.desc}</div>
                </div>
                <div class="feature-status ${enabled ? 'on' : 'off'}">${enabled ? 'ON' : 'OFF'}</div>
            `;
            row.querySelector('input[data-feature]').addEventListener('change', (e) => {
                agent.setFeatureFlag(key, e.target.checked);
                row.querySelector('.feature-status').textContent = e.target.checked ? 'ON' : 'OFF';
                row.querySelector('.feature-status').classList.toggle('on', e.target.checked);
                row.querySelector('.feature-status').classList.toggle('off', !e.target.checked);
                addLog('Funkcja "' + key + '": ' + (e.target.checked ? 'ON' : 'OFF'), 'info');
            });
            featureFlagsList.appendChild(row);
        });
    }
    function renderToolsQuickList() {
        if (!toolsQuickList) return;
        toolsQuickList.innerHTML = '';
        const tools = agent.listAllTools();
        const customTools = tools.filter(t => !t.isBuiltin);
        if (customTools.length === 0) {
            toolsQuickList.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);text-align:center;padding:0.4rem;">' + escapeAttr(tr('tools-no-custom')) + '</div>';
            return;
        }
        customTools.forEach(t => {
            const row = document.createElement('div');
            row.className = 'feature-row';
            const lbl = toolLabel(t);
            const desc = toolDesc(t);
            row.innerHTML = `
                <label class="toggle-switch">
                    <input type="checkbox" data-tool="${t.name}" ${t.enabled ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
                <div style="flex:1;">
                    <div style="font-size: 12px; font-weight: 500;">${t.icon} ${escapeAttr(lbl)}</div>
                    <div style="font-size: 10px; color: var(--text-secondary);">${escapeAttr(desc)}</div>
                </div>
                <span class="badge ${t.kind === 'python_skill' ? 'feat' : ''}">${escapeAttr(t.kind)}</span>
            `;
            row.querySelector('input[data-tool]').addEventListener('change', (e) => {
                agent.setToolEnabled(t.name, e.target.checked);
                addLog('Tool "' + t.name + '": ' + (e.target.checked ? 'ON' : 'OFF'), 'info');
            });
            toolsQuickList.appendChild(row);
        });
    }
    const openToolsFromFeatures = document.getElementById('open-tools-modal-from-features');
    if (openToolsFromFeatures) openToolsFromFeatures.addEventListener('click', () => openToolsModal());

    // ===== Tools full modal (with per-tool settings tabs) ==============
    const toolsOverlay = document.getElementById('tools-overlay');
    const toolsBtn = document.getElementById('tools-btn');
    const closeToolsBtn = document.getElementById('close-tools-btn');
    const toolsSidebarList = document.getElementById('tools-sidebar-list');
    const toolDetailPane = document.getElementById('tool-detail-pane');
    const toolsFilter = document.getElementById('tools-filter');
    const toolsStats = document.getElementById('tools-stats');
    const toolsRefreshBtn = document.getElementById('tools-refresh-btn');
    let selectedToolName = null;

    function openToolsModal() {
        if (settingsOverlay) settingsOverlay.classList.add('hidden');
        toolsOverlay.classList.remove('hidden');
        renderToolsSidebar();
    }
    if (toolsBtn) toolsBtn.addEventListener('click', openToolsModal);
    if (closeToolsBtn) closeToolsBtn.addEventListener('click', () => toolsOverlay.classList.add('hidden'));
    if (toolsRefreshBtn) toolsRefreshBtn.addEventListener('click', () => renderToolsSidebar());
    if (toolsFilter) toolsFilter.addEventListener('input', renderToolsSidebar);

    // Resolve a tool's localized label/description (falls back to English fields, then to name)
    function toolLabel(t) {
        if (t.labelKey) {
            const v = tr(t.labelKey);
            if (v && v !== t.labelKey) return v;
        }
        return t.label || t.name;
    }
    function toolDesc(t) {
        if (t.descKey) {
            const v = tr(t.descKey);
            if (v && v !== t.descKey) return v;
        }
        return t.description || '';
    }
    function toolGroupName(kind) {
        switch (kind) {
            case 'generator':    return tr('tools-group-generators');
            case 'integration':  return tr('tools-group-integrations');
            case 'python_skill': return tr('tools-group-pyskills');
            case 'background':   return tr('tools-group-background');
            default:             return tr('tools-group-other');
        }
    }

    function renderToolsSidebar() {
        const tools = agent.listAllTools();
        const q = (toolsFilter && toolsFilter.value || '').toLowerCase().trim();
        const filtered = q ? tools.filter(t => (t.name + ' ' + toolLabel(t) + ' ' + toolDesc(t)).toLowerCase().indexOf(q) !== -1) : tools;
        toolsSidebarList.innerHTML = '';
        const groups = {};
        filtered.forEach(t => {
            const g = toolGroupName(t.kind);
            (groups[g] = groups[g] || []).push(t);
        });
        Object.keys(groups).forEach(gName => {
            const header = document.createElement('div');
            header.className = 'tools-group-header';
            header.textContent = gName + ' (' + groups[gName].length + ')';
            toolsSidebarList.appendChild(header);
            groups[gName].forEach(t => {
                const row = document.createElement('div');
                row.className = 'tools-sidebar-row' + (t.name === selectedToolName ? ' selected' : '');
                const lbl = toolLabel(t);
                const desc = toolDesc(t);
                row.innerHTML = `
                    <div class="tools-row-icon">${t.icon}</div>
                    <div class="tools-row-meta">
                        <div class="tools-row-name">${escapeAttr(lbl)}</div>
                        <div class="tools-row-desc">${escapeAttr(desc.substring(0, 50))}${desc.length > 50 ? '...' : ''}</div>
                    </div>
                    <label class="toggle-switch small" title="${escapeAttr(tr('tools-toggle-title'))}">
                        <input type="checkbox" ${t.enabled ? 'checked' : ''} data-tool-toggle="${t.name}">
                        <span class="slider"></span>
                    </label>
                `;
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.toggle-switch')) return;
                    selectedToolName = t.name;
                    renderToolsSidebar();
                    renderToolDetail(t);
                });
                row.querySelector('input[data-tool-toggle]').addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (t.isBuiltin) {
                        agent.setFeatureFlag(t.featureFlag, e.target.checked);
                    } else {
                        agent.setToolEnabled(t.name, e.target.checked);
                    }
                    addLog('Tool "' + t.name + '": ' + (e.target.checked ? 'ON' : 'OFF'), 'info');
                    renderToolsQuickList();
                });
                toolsSidebarList.appendChild(row);
            });
        });
        if (filtered.length === 0) {
            toolsSidebarList.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-secondary); font-size:11px;">' + escapeAttr(tr('tools-empty-filter')) + '</div>';
        }
        if (toolsStats) {
            const totalCount = tools.length;
            const activeCount = tools.filter(t => t.enabled).length;
            toolsStats.textContent = tr('tools-stats').replace('{total}', totalCount).replace('{active}', activeCount);
        }
    }

    function renderToolDetail(tool) {
        toolDetailPane.innerHTML = '';
        const wrap = document.createElement('div');
        const lbl = toolLabel(tool);
        const desc = toolDesc(tool);
        const statusLabel = tool.enabled
            ? '<span style="color:#10b981;">' + escapeAttr(tr('tools-status-on')) + '</span>'
            : '<span style="color:#ef4444;">' + escapeAttr(tr('tools-status-off')) + '</span>';

        // Header
        const header = document.createElement('div');
        header.className = 'tool-detail-header';
        header.innerHTML = `
            <div style="font-size:24px;">${tool.icon}</div>
            <div style="flex:1;">
                <h3 style="margin:0; color: var(--accent);">${escapeAttr(lbl)}</h3>
                <div style="font-size: 11px; color: var(--text-secondary);">${escapeAttr(tool.kind)} · ${statusLabel}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" id="detail-toggle" ${tool.enabled ? 'checked' : ''}>
                <span class="slider"></span>
            </label>
        `;
        wrap.appendChild(header);

        // Description
        if (desc) {
            const descEl = document.createElement('div');
            descEl.className = 'tool-detail-desc';
            descEl.textContent = desc;
            wrap.appendChild(descEl);
        }

        // Tabs: Overview / Settings / [Environment] / [Runtime]
        const tabs = document.createElement('div');
        tabs.className = 'tool-detail-tabs';
        const tabLabels = [tr('tools-detail-overview'), tr('tools-detail-settings')];
        if (tool.kind === 'python_skill' || tool.kind === 'background') tabLabels.push(tr('tools-detail-env'));
        if (tool.runtime) tabLabels.push(tr('tools-detail-runtime'));
        tabLabels.forEach((label, idx) => {
            const tab = document.createElement('button');
            tab.className = 'tool-detail-tab' + (idx === 0 ? ' active' : '');
            tab.textContent = label;
            tab.addEventListener('click', () => {
                wrap.querySelectorAll('.tool-detail-tab').forEach(t => t.classList.remove('active'));
                wrap.querySelectorAll('.tool-detail-pane').forEach(p => p.classList.add('hidden'));
                tab.classList.add('active');
                const idx2 = Array.from(tabs.children).indexOf(tab);
                const panes = wrap.querySelectorAll('.tool-detail-pane');
                if (panes[idx2]) panes[idx2].classList.remove('hidden');
            });
            tabs.appendChild(tab);
        });
        wrap.appendChild(tabs);

        // Pane 1: Overview
        const pane1 = document.createElement('div');
        pane1.className = 'tool-detail-pane';
        const overviewRows = [];
        overviewRows.push([tr('tools-detail-row-name'), tool.name]);
        overviewRows.push([tr('tools-detail-row-type'), tool.kind]);
        overviewRows.push([tr('tools-detail-row-state'), tool.enabled ? tr('tools-status-on') : tr('tools-status-off')]);
        if (tool.env) overviewRows.push([tr('tools-detail-row-env'), tool.env]);
        if (tool.packages && tool.packages.length) overviewRows.push([tr('tools-detail-row-packages'), tool.packages.join(', ')]);
        if (tool.createdAt) overviewRows.push([tr('tools-detail-row-created'), tool.createdAt]);
        if (tool.featureFlag) overviewRows.push([tr('tools-detail-row-flag'), tool.featureFlag]);
        overviewRows.forEach(([k, v]) => {
            const div = document.createElement('div');
            div.className = 'kv-row';
            div.innerHTML = '<div class="k">' + escapeAttr(k) + '</div><div class="v">' + escapeAttr(String(v)) + '</div>';
            pane1.appendChild(div);
        });
        wrap.appendChild(pane1);

        // Pane 2: Settings (custom key/value editor)
        const pane2 = document.createElement('div');
        pane2.className = 'tool-detail-pane hidden';
        const sett = agent.getToolSettings(tool.name);
        renderToolSettingsEditor(pane2, tool, sett);
        wrap.appendChild(pane2);

        // Pane 3: Environment info (python_skill / background)
        if (tool.kind === 'python_skill' || tool.kind === 'background') {
            const pane3 = document.createElement('div');
            pane3.className = 'tool-detail-pane hidden';
            const envContent = document.createElement('div');
            if (tool.env) {
                envContent.innerHTML = `
                    <div class="kv-row"><div class="k">${escapeAttr(tr('tools-detail-row-venv-folder'))}</div><div class="v"><code>${escapeAttr(agent.getPythonSandboxRoot())}/${escapeAttr(tool.env)}</code></div></div>
                `;
                if (tool.raw && tool.raw.scriptContent) {
                    const codeBlock = document.createElement('pre');
                    codeBlock.className = 'code-block';
                    codeBlock.textContent = tool.raw.scriptContent.substring(0, 5000);
                    envContent.appendChild(codeBlock);
                }
            }
            if (tool.runtime) {
                envContent.innerHTML += `
                    <div class="kv-row"><div class="k">PID</div><div class="v">${tool.runtime.pid}</div></div>
                    <div class="kv-row"><div class="k">Status</div><div class="v">${escapeAttr(tool.runtime.status)}</div></div>
                    <div class="kv-row"><div class="k">Ready</div><div class="v">${tool.runtime.isReady ? '✓' : '—'}</div></div>
                `;
            }
            pane3.appendChild(envContent);
            wrap.appendChild(pane3);
        }

        // Pane 4: Runtime (only if exists)
        if (tool.runtime) {
            const pane4 = document.createElement('div');
            pane4.className = 'tool-detail-pane hidden';
            const stopBtn = document.createElement('button');
            stopBtn.className = 'mini-btn';
            stopBtn.textContent = tr('tools-detail-stop-process');
            stopBtn.addEventListener('click', () => {
                if (agent.killBackgroundProcess) {
                    const name = tool.name.replace(/^bg_/, '');
                    if (agent.killBackgroundProcess(name)) {
                        addLog(tr('tools-detail-stopped') + ': ' + name, 'success');
                        renderToolsSidebar();
                    }
                }
            });
            pane4.appendChild(stopBtn);
            wrap.appendChild(pane4);
        }

        // Wire toggle
        wrap.querySelector('#detail-toggle').addEventListener('change', (e) => {
            if (tool.isBuiltin) agent.setFeatureFlag(tool.featureFlag, e.target.checked);
            else agent.setToolEnabled(tool.name, e.target.checked);
            addLog('Tool "' + tool.name + '": ' + (e.target.checked ? 'ON' : 'OFF'), 'info');
            renderToolsSidebar();
        });

        toolDetailPane.appendChild(wrap);
    }

    // =================================================================
    // Tool settings schemas — proper, user-friendly forms per tool
    // =================================================================
    // Each schema is a list of sections, each with a list of fields:
    //   { key, label, help, type: 'text|number|select|toggle|range|textarea|kv',
    //     default, min, max, step, options: [{value,label}], unit, validate? }
    const toolSchemas = {
        imageGen: {
            sections: [
                {
                    title: { pl: 'Domyślne parametry', en: 'Default parameters' },
                    fields: [
                        { key: 'default_size', label: { pl: 'Domyślny rozmiar', en: 'Default size' }, type: 'select', default: '1024x1024',
                          options: [
                              { value: '1024x1024', label: '1024×1024 (kwadrat / square)' },
                              { value: '1792x1024', label: '1792×1024 (16:9 landscape)' },
                              { value: '1024x1792', label: '1024×1792 (9:16 portrait/Reels)' },
                              { value: '1536x1024', label: '1536×1024 (3:2 photo)' },
                              { value: '1024x1536', label: '1024×1536 (2:3 portrait)' }
                          ],
                          help: { pl: 'Rozmiar przy generowaniu. Większy = wolniej + drożej.', en: 'Generation size. Bigger = slower + costlier.' }
                        },
                        { key: 'max_per_step', label: { pl: 'Max obrazów na krok', en: 'Max images per step' }, type: 'number', default: 4, min: 1, max: 8,
                          help: { pl: 'Limit jednoczesnego generowania (chroni przed rate limit).', en: 'Concurrency limit (protects from rate limits).' } },
                        { key: 'style_hint', label: { pl: 'Domyślny styl/podpowiedź', en: 'Default style hint' }, type: 'text', default: '',
                          help: { pl: 'Np. „photo-realistic 35mm". Dodawane do każdego prompta.', en: 'E.g. "photo-realistic 35mm". Appended to every prompt.' } },
                        { key: 'add_watermark_hint', label: { pl: 'Bez logotypów/znaków wodnych', en: 'No logos/watermarks' }, type: 'toggle', default: true,
                          help: { pl: 'Dopisuje do prompta wykluczenie watermarków.', en: 'Adds an exclusion for watermarks.' } }
                    ]
                }
            ]
        },
        imageEdit: {
            sections: [
                {
                    title: { pl: 'Edycja obrazów', en: 'Image editing' },
                    fields: [
                        { key: 'preserve_original', label: { pl: 'Zachowaj oryginał obok edycji', en: 'Keep original alongside edit' }, type: 'toggle', default: true,
                          help: { pl: 'Plik źródłowy nie jest nadpisywany — agent widzi oba w manifeście.', en: 'Source isn\'t overwritten — agent sees both in manifest.' } },
                        { key: 'preferred_strength', label: { pl: 'Domyślna siła edycji', en: 'Default edit strength' }, type: 'range', default: 0.8, min: 0, max: 1, step: 0.05,
                          help: { pl: 'Wskazówka dla modelu — 1.0 = pełna zmiana, 0.3 = subtelna korekta.', en: 'Hint to the model — 1.0 = full change, 0.3 = subtle correction.' } }
                    ]
                }
            ]
        },
        videoGen: {
            sections: [
                {
                    title: { pl: 'Grok Imagine Video', en: 'Grok Imagine Video' },
                    fields: [
                        { key: 'default_duration', label: { pl: 'Domyślna długość', en: 'Default duration' }, type: 'select', default: '5',
                          options: [
                              { value: '3', label: '3 s' }, { value: '5', label: '5 s' },
                              { value: '8', label: '8 s' }, { value: '10', label: '10 s' }
                          ],
                          help: { pl: 'Krótsze = taniej + szybciej.', en: 'Shorter = cheaper + faster.' } },
                        { key: 'default_aspect_ratio', label: { pl: 'Domyślne proporcje', en: 'Default aspect ratio' }, type: 'select', default: '16:9',
                          options: [
                              { value: '16:9', label: '16:9 (landscape)' },
                              { value: '9:16', label: '9:16 (portrait / Reels / TikTok)' },
                              { value: '1:1', label: '1:1 (square / Instagram)' },
                              { value: '4:3', label: '4:3 (classic TV)' },
                              { value: 'auto', label: 'auto (z obrazu źródłowego)' }
                          ] },
                        { key: 'max_per_step', label: { pl: 'Max wideo na krok', en: 'Max videos per step' }, type: 'number', default: 2, min: 1, max: 4 }
                    ]
                }
            ]
        },
        ttsGen: {
            sections: [
                {
                    title: { pl: 'Lektor (TTS)', en: 'Voice (TTS)' },
                    fields: [
                        { key: 'fallback_voice_hint', label: { pl: 'Domyślny tag głosu (gdy brak prefiksu)', en: 'Default voice tag (when no prefix)' }, type: 'text', default: '',
                          help: { pl: 'Np. „Female:" – używane gdy agent nie poda płci w prompcie.', en: 'E.g. "Female:" — used when agent doesn\'t specify gender.' } },
                        { key: 'max_chars_per_chunk', label: { pl: 'Max znaków na jeden plik TTS', en: 'Max chars per single TTS file' }, type: 'number', default: 3000, min: 200, max: 5000,
                          help: { pl: 'Dłuższe teksty są dzielone (wymaga osobnego rozwoju w generate).', en: 'Longer texts get chunked (requires extra dev in generate).' } }
                    ]
                },
                {
                    title: { pl: 'Informacja', en: 'Info' },
                    fields: [
                        { key: '_info', label: { pl: 'Pełne ustawienia ElevenLabs w zakładce TTS / STT', en: 'Full ElevenLabs settings in TTS / STT tab' }, type: 'info' }
                    ]
                }
            ]
        },
        sttGen: {
            sections: [
                {
                    title: { pl: 'Speech-to-Text', en: 'Speech-to-Text' },
                    fields: [
                        { key: 'default_language', label: { pl: 'Wymuś język transkrypcji', en: 'Force transcription language' }, type: 'select', default: '',
                          options: [
                              { value: '', label: '(auto-detect)' },
                              { value: 'pol', label: 'Polski (pol)' }, { value: 'eng', label: 'English (eng)' },
                              { value: 'deu', label: 'Deutsch (deu)' }, { value: 'spa', label: 'Español (spa)' },
                              { value: 'fra', label: 'Français (fra)' }, { value: 'jpn', label: '日本語 (jpn)' },
                              { value: 'ita', label: 'Italiano (ita)' }, { value: 'ces', label: 'Čeština (ces)' }
                          ],
                          help: { pl: 'Wymuś konkretny język zamiast auto-detect.', en: 'Override auto-detection.' } },
                        { key: 'tag_audio_events', label: { pl: 'Taguj zdarzenia audio (śmiech, oddech)', en: 'Tag audio events (laughter, breath)' }, type: 'toggle', default: true },
                        { key: 'diarize', label: { pl: 'Rozpoznawanie mówców (diarization)', en: 'Speaker diarization' }, type: 'toggle', default: false,
                          help: { pl: 'Przydaje się przy nagraniach 2+ osób.', en: 'Useful for 2+ speakers.' } }
                    ]
                }
            ]
        },
        musicGen: {
            sections: [
                {
                    title: { pl: 'Provider muzyki', en: 'Music provider' },
                    fields: [
                        { key: '_info', label: { pl: 'Aktualny provider muzyki konfigurujesz w zakładce TTS / STT → "🔊 Efekty Dźwiękowe i Muzyka". Wybierz Lyria 3 Pro (Gemini, instrumental) lub Eleven Music (z opcją wokali).', en: 'Configure the active music provider in the TTS / STT tab → "🔊 Sound Effects and Music". Pick Lyria 3 Pro (Gemini, instrumental) or Eleven Music (with optional vocals).' }, type: 'info' }
                    ]
                },
                {
                    title: { pl: 'Mix audio', en: 'Audio mix' },
                    fields: [
                        { key: 'music_db_offset', label: { pl: 'Głośność muzyki pod lektorem (dB)', en: 'Music volume under voiceover (dB)' }, type: 'number', default: -15, min: -30, max: 0, step: 1, unit: 'dB',
                          help: { pl: 'Auto-mix: muzyka ściszona względem lektora. -15 dB to standard filmowy.', en: 'Auto-mix: music ducked vs voiceover. -15 dB is cinematic standard.' } },
                        { key: 'match_voice_duration', label: { pl: 'Dopasuj długość do lektora', en: 'Match duration to voiceover' }, type: 'toggle', default: true,
                          help: { pl: 'System automatycznie dodaje [0:00 – M:SS] do prompta Lyria lub duration_seconds do Eleven Music.', en: 'System auto-adds [0:00 – M:SS] to Lyria prompt or duration_seconds to Eleven Music.' } }
                    ]
                }
            ]
        },
        sfxGen: {
            sections: [
                {
                    title: { pl: 'ElevenLabs Sound Effects', en: 'ElevenLabs Sound Effects' },
                    fields: [
                        { key: 'default_prompt_influence', label: { pl: 'Domyślny prompt_influence', en: 'Default prompt_influence' }, type: 'range', default: 0.3, min: 0, max: 1, step: 0.05,
                          help: { pl: 'Jak literalnie model ma traktować prompt. 0 = kreatywnie, 1 = dokładnie wg opisu. Default 0.3.', en: '0 = creative, 1 = literal. Default 0.3.' } },
                        { key: 'default_duration_seconds', label: { pl: 'Domyślna długość (0 = auto)', en: 'Default duration (0 = auto)' }, type: 'number', default: 0, min: 0, max: 22, step: 0.5, unit: 's',
                          help: { pl: 'Zakres 0.5-22s. Wartość 0 = niech model sam zdecyduje.', en: 'Range 0.5-22s. 0 = let the model decide.' } },
                        { key: 'auto_loop_ambient', label: { pl: 'Auto-loop dla ambientu', en: 'Auto-loop for ambient' }, type: 'toggle', default: false,
                          help: { pl: 'Jeśli prompt zawiera „ambient", „rain", „wind" — wymuś loop=true.', en: 'If prompt contains "ambient", "rain", "wind" — force loop=true.' } }
                    ]
                }
            ]
        },
        svgGen: {
            sections: [
                {
                    title: { pl: 'Generator SVG', en: 'SVG Generator' },
                    fields: [
                        { key: 'canvas_size', label: { pl: 'Domyślne wymiary viewBox', en: 'Default viewBox size' }, type: 'select', default: '512',
                          options: [
                              { value: '256', label: '256×256 (ikona)' },
                              { value: '512', label: '512×512 (standard)' },
                              { value: '1024', label: '1024×1024 (HQ)' },
                              { value: '1920x1080', label: '1920×1080 (Full HD landscape)' }
                          ] },
                        { key: 'style_preference', label: { pl: 'Preferowany styl', en: 'Preferred style' }, type: 'select', default: 'modern',
                          options: [
                              { value: 'modern', label: 'Modern / minimal' },
                              { value: 'flat', label: 'Flat / 2D' },
                              { value: 'gradient', label: 'Gradient / colorful' },
                              { value: 'isometric', label: 'Isometric / 3D illusion' },
                              { value: 'hand-drawn', label: 'Hand-drawn / sketch' }
                          ] }
                    ]
                }
            ]
        },
        grounding: {
            sections: [
                {
                    title: { pl: 'Google Search Grounding', en: 'Google Search Grounding' },
                    fields: [
                        { key: '_info', label: { pl: 'Funkcja aktywna tylko dla dostawcy Gemini. Włącza Live Web Search w odpowiedzi LLM. Brak konfigurowalnych parametrów — Google decyduje kiedy szukać.', en: 'Active only for Gemini provider. Enables Live Web Search in LLM responses. No configurable parameters — Google decides when to search.' }, type: 'info' }
                    ]
                }
            ]
        },
        renderPreview: {
            sections: [
                {
                    title: { pl: 'Multi-frame podgląd dla Vision', en: 'Multi-frame Vision preview' },
                    fields: [
                        { key: 'default_frames', label: { pl: 'Domyślna liczba klatek', en: 'Default frame count' }, type: 'number', default: 4, min: 2, max: 8, step: 1,
                          help: { pl: 'Klatki równomiernie rozłożone na osi timeline.', en: 'Frames evenly distributed across timeline.' } }
                    ]
                }
            ]
        },
        pythonTools: {
            sections: [
                {
                    title: { pl: 'Środowiska Python', en: 'Python environments' },
                    fields: [
                        { key: 'extra_pip_index', label: { pl: 'Dodatkowy index PIP (opcjonalny)', en: 'Extra PIP index (optional)' }, type: 'text', default: '',
                          help: { pl: 'Np. dla PyTorch CUDA: https://download.pytorch.org/whl/cu121', en: 'E.g. for PyTorch CUDA: https://download.pytorch.org/whl/cu121' } },
                        { key: 'python_executable', label: { pl: 'Polecenie Python (system)', en: 'Python executable (system)' }, type: 'text', default: 'python',
                          help: { pl: 'Np. „python3", „py -3.11". Używane przy tworzeniu nowych venv.', en: 'E.g. "python3", "py -3.11". Used when creating new venvs.' } },
                        { key: 'venv_timeout_sec', label: { pl: 'Timeout instalacji pakietów (sek.)', en: 'Package install timeout (sec)' }, type: 'number', default: 600, min: 60, max: 3600 },
                        { key: 'cleanup_old_envs_days', label: { pl: 'Auto-usuwanie nieużywanych venv (dni)', en: 'Auto-remove unused venvs (days)' }, type: 'number', default: 0, min: 0, max: 365,
                          help: { pl: '0 = wyłączone. Inna wartość = usuwa venv nieużywane od X dni.', en: '0 = disabled. Otherwise removes venvs unused for X days.' } }
                    ]
                }
            ]
        }
    };

    // Schema for python skills (default for any pyskill_*)
    const pySkillSchema = {
        sections: [
            {
                title: { pl: 'Wykonanie', en: 'Execution' },
                fields: [
                    { key: 'timeout_sec', label: { pl: 'Timeout uruchomienia (sek.)', en: 'Run timeout (sec)' }, type: 'number', default: 300, min: 10, max: 3600 },
                    { key: 'cwd_override', label: { pl: 'Katalog roboczy (override)', en: 'Working directory (override)' }, type: 'text', default: '',
                      help: { pl: 'Puste = katalog venv. Wpisz pełną ścieżkę by zmienić.', en: 'Empty = venv folder. Enter full path to override.' } },
                    { key: 'env_vars', label: { pl: 'Zmienne środowiskowe', en: 'Environment variables' }, type: 'kv',
                      help: { pl: 'Pary KLUCZ=wartość przekazywane do procesu.', en: 'KEY=value pairs passed to the process.' } }
                ]
            }
        ]
    };

    // Schema for background processes
    const bgProcessSchema = {
        sections: [
            {
                title: { pl: 'Proces tła', en: 'Background process' },
                fields: [
                    { key: 'auto_restart', label: { pl: 'Auto-restart przy crashu', en: 'Auto-restart on crash' }, type: 'toggle', default: false },
                    { key: 'health_check_url', label: { pl: 'URL health-check (opcj.)', en: 'Health-check URL (optional)' }, type: 'text', default: '',
                      help: { pl: 'Np. http://localhost:7860 — wtyczka odpyta przed użyciem.', en: 'E.g. http://localhost:7860 — plugin pings before use.' } },
                    { key: 'ready_keyword', label: { pl: 'Słowo kluczowe gotowości', en: 'Ready keyword' }, type: 'text', default: '',
                      help: { pl: 'Tekst w stdout który oznacza „gotowy" (np. „listening on").', en: 'Stdout text meaning "ready" (e.g. "listening on").' } }
                ]
            }
        ]
    };

    function pickI18n(obj) {
        if (typeof obj === 'string') return obj;
        if (!obj) return '';
        return obj[_activeLang] || obj.en || obj.pl || '';
    }

    function buildFieldControl(field, value, onChange) {
        const wrap = document.createElement('div');
        wrap.className = 'tool-form-field';
        const labelEl = document.createElement('div');
        labelEl.className = 'tool-form-label';
        labelEl.textContent = pickI18n(field.label);
        if (field.unit) labelEl.innerHTML += ' <span style="color:var(--text-secondary); font-size:10px;">(' + field.unit + ')</span>';
        wrap.appendChild(labelEl);

        const v = (value === undefined || value === null) ? field.default : value;

        if (field.type === 'info') {
            const info = document.createElement('div');
            info.style.cssText = 'font-size:11.5px; color:var(--text-secondary); padding:6px 8px; background:rgba(0,0,0,0.18); border-radius:6px; border-left:3px solid var(--accent);';
            info.innerHTML = pickI18n(field.label);
            labelEl.remove();
            wrap.appendChild(info);
            return wrap;
        }

        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            field.options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value; o.textContent = opt.label;
                if (String(opt.value) === String(v)) o.selected = true;
                input.appendChild(o);
            });
            input.addEventListener('change', () => onChange(input.value));
            wrap.appendChild(input);
        } else if (field.type === 'toggle') {
            const lbl = document.createElement('label');
            lbl.className = 'toggle-switch';
            lbl.style.cssText = 'display:inline-block; margin-top:4px;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!v;
            cb.addEventListener('change', () => onChange(cb.checked));
            const sl = document.createElement('span');
            sl.className = 'slider';
            lbl.appendChild(cb);
            lbl.appendChild(sl);
            wrap.appendChild(lbl);
        } else if (field.type === 'range') {
            input = document.createElement('input');
            input.type = 'range';
            input.min = field.min != null ? field.min : 0;
            input.max = field.max != null ? field.max : 1;
            input.step = field.step != null ? field.step : 0.1;
            input.value = v;
            input.style.width = '100%';
            const valSpan = document.createElement('span');
            valSpan.style.cssText = 'color:var(--accent); font-size:11px; margin-left:8px;';
            valSpan.textContent = Number(v).toFixed(2);
            input.addEventListener('input', () => {
                valSpan.textContent = Number(input.value).toFixed(2);
                onChange(parseFloat(input.value));
            });
            labelEl.appendChild(valSpan);
            wrap.appendChild(input);
        } else if (field.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            if (field.min != null) input.min = field.min;
            if (field.max != null) input.max = field.max;
            if (field.step != null) input.step = field.step;
            input.value = v;
            input.addEventListener('change', () => onChange(input.value === '' ? '' : Number(input.value)));
            wrap.appendChild(input);
        } else if (field.type === 'textarea') {
            input = document.createElement('textarea');
            input.value = v || '';
            input.style.minHeight = '60px';
            input.addEventListener('change', () => onChange(input.value));
            wrap.appendChild(input);
        } else if (field.type === 'kv') {
            // Multi-pair editor
            const list = document.createElement('div');
            list.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
            let current = (v && typeof v === 'object') ? Object.assign({}, v) : {};
            function refreshKV() {
                list.innerHTML = '';
                Object.keys(current).forEach(k => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; gap:4px;';
                    row.innerHTML = '<input type="text" value="' + escapeAttr(k) + '" readonly style="flex:1; font-size:11px;"> <input type="text" value="' + escapeAttr(String(current[k])) + '" data-edit-k="' + escapeAttr(k) + '" style="flex:2; font-size:11px;"> <button class="mini-btn" data-del-k="' + escapeAttr(k) + '">✕</button>';
                    row.querySelector('[data-edit-k]').addEventListener('change', (e) => { current[k] = e.target.value; onChange(Object.assign({}, current)); });
                    row.querySelector('[data-del-k]').addEventListener('click', () => { delete current[k]; refreshKV(); onChange(Object.assign({}, current)); });
                    list.appendChild(row);
                });
                const addRow = document.createElement('div');
                addRow.style.cssText = 'display:flex; gap:4px; border-top:1px dashed rgba(255,255,255,0.06); padding-top:4px;';
                addRow.innerHTML = '<input type="text" placeholder="KEY" class="new-k" style="flex:1; font-size:11px;"><input type="text" placeholder="value" class="new-v" style="flex:2; font-size:11px;"><button class="mini-btn add-kv">+</button>';
                addRow.querySelector('.add-kv').addEventListener('click', () => {
                    const k = addRow.querySelector('.new-k').value.trim();
                    if (!k) return;
                    current[k] = addRow.querySelector('.new-v').value;
                    refreshKV(); onChange(Object.assign({}, current));
                });
                list.appendChild(addRow);
            }
            refreshKV();
            wrap.appendChild(list);
        } else {
            // Default: text
            input = document.createElement('input');
            input.type = 'text';
            input.value = v == null ? '' : v;
            input.addEventListener('change', () => onChange(input.value));
            wrap.appendChild(input);
        }
        if (field.help) {
            const hint = document.createElement('div');
            hint.className = 'tool-form-help';
            hint.textContent = pickI18n(field.help);
            wrap.appendChild(hint);
        }
        return wrap;
    }

    function renderToolSettingsEditor(pane, tool, sett) {
        pane.innerHTML = '';
        // Pick schema
        let schema = toolSchemas[tool.name];
        if (!schema) {
            if (tool.kind === 'python_skill') schema = pySkillSchema;
            else if (tool.kind === 'background') schema = bgProcessSchema;
        }
        if (!schema) {
            // Unknown / no-config tool — show generic message + basic kv editor
            const info = document.createElement('div');
            info.style.cssText = 'font-size:12px; color:var(--text-secondary); padding:0.8rem; background:rgba(0,0,0,0.15); border-radius:6px; margin-bottom: 0.6rem;';
            info.textContent = tr('tools-settings-no-config');
            pane.appendChild(info);
            const customSectionLabel = tr('tools-settings-section-custom');
            const kvLabel = tr('tools-settings-kv-label');
            schema = { sections: [{ title: { pl: customSectionLabel, en: customSectionLabel }, fields: [{ key: '__custom', label: { pl: kvLabel, en: kvLabel }, type: 'kv' }] }] };
        }
        const current = agent.getToolSettings(tool.name);

        schema.sections.forEach(section => {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'tool-form-section';
            const h = document.createElement('h4');
            h.textContent = pickI18n(section.title);
            sectionEl.appendChild(h);
            section.fields.forEach(field => {
                const fieldEl = buildFieldControl(field, current[field.key], (newVal) => {
                    const cur = agent.getToolSettings(tool.name);
                    cur[field.key] = newVal;
                    agent.setToolSettings(tool.name, cur);
                });
                sectionEl.appendChild(fieldEl);
            });
            pane.appendChild(sectionEl);
        });

        // Action buttons: reset to defaults
        const actions = document.createElement('div');
        actions.className = 'tool-form-actions';
        const resetBtn = document.createElement('button');
        resetBtn.className = 'tool-form-btn danger';
        resetBtn.textContent = tr('tools-settings-reset');
        resetBtn.addEventListener('click', () => {
            if (confirm(tr('tools-settings-reset-confirm'))) {
                agent.setToolSettings(tool.name, {});
                renderToolDetail(tool);
            }
        });
        actions.appendChild(resetBtn);
        pane.appendChild(actions);
    }

    // ===== Provider toggling --------------------------------------------
    function updateProviderConfigVisibility() {
        const llmActive = (llmProviderSelect && llmProviderSelect.value) || agent.llmProvider || 'gemini';
        document.querySelectorAll('.provider-config[data-provider]').forEach(div => {
            div.classList.toggle('hidden', div.getAttribute('data-provider') !== llmActive);
        });
        const imgActive = (imgProviderSelect && imgProviderSelect.value) || agent.imgProvider || 'gemini';
        document.querySelectorAll('.provider-config[data-img-provider]').forEach(div => {
            div.classList.toggle('hidden', div.getAttribute('data-img-provider') !== imgActive);
        });
    }
    if (llmProviderSelect) llmProviderSelect.addEventListener('change', updateProviderConfigVisibility);
    if (imgProviderSelect) imgProviderSelect.addEventListener('change', updateProviderConfigVisibility);
    updateProviderConfigVisibility();

    // ---- Dynamic model lists ------------------------------------------
    // Build a compact, modal-friendly label for a model option.
    // Default: short name. Title attribute keeps the full string for hover/tooltip.
    function formatModelLabel(m) {
        // Strip "models/" prefix and any 4-digit date trailing slug for readability
        let id = (m.id || '').replace(/^models\//, '');
        const shortId = id.length > 28 ? id.substring(0, 26) + '…' : id;
        let label = m.name || shortId;
        // If name was just the id (no friendlier name), avoid repeating it
        if (label.toLowerCase() === id.toLowerCase()) {
            label = shortId;
        } else if (label.length > 26) {
            label = label.substring(0, 24) + '…';
        } else {
            // Append a tiny ctx hint if name is short enough
            if (m.contextLength) {
                const ctx = m.contextLength >= 1_000_000
                    ? (m.contextLength / 1_000_000).toFixed(1) + 'M'
                    : Math.round(m.contextLength / 1000) + 'k';
                label = label + ' · ' + ctx;
            }
        }
        return label;
    }
    function fullModelTitle(m) {
        const parts = [];
        if (m.name) parts.push(m.name);
        parts.push(m.id);
        if (m.contextLength) parts.push(Math.round(m.contextLength / 1000) + 'k ctx');
        if (m.outputLimit) parts.push('out ' + Math.round(m.outputLimit / 1000) + 'k');
        if (m.description) parts.push(m.description);
        return parts.join(' · ');
    }

    async function loadGeminiModels(force) {
        if (!agent.apiKey) {
            baseModelSelect.innerHTML = '<option value="">⚠ Brak klucza Gemini API</option>';
            imageModelSelect.innerHTML = '<option value="">⚠ Brak klucza Gemini API</option>';
            ttsModelSelect.innerHTML = '<option value="">⚠ Brak klucza Gemini API</option>';
            return;
        }
        try {
            addLog(tr('log-fetching-gemini-models'), 'info');
            const list = await agent.fetchModels('gemini', !!force);
            const llmList = list.filter(m => !/image|tts|embedding|aqa/i.test(m.id));
            const imgList = list.filter(m => /image/i.test(m.id));
            const ttsList = list.filter(m => /tts/i.test(m.id));
            const fill = (sel, items, current) => {
                if (!sel) return;
                sel.innerHTML = '';
                if (items.length === 0) { sel.innerHTML = '<option value="">(brak dostępnych modeli)</option>'; return; }
                items.forEach(m => {
                    const o = document.createElement('option');
                    o.value = m.id;
                    o.textContent = formatModelLabel(m);
                    o.title = fullModelTitle(m);
                    sel.appendChild(o);
                });
                if (current && items.find(m => m.id === current)) sel.value = current;
            };
            fill(baseModelSelect, llmList, agent.geminiModel);
            fill(imageModelSelect, imgList, agent.geminiImageModel);
            fill(ttsModelSelect, ttsList, agent.ttsModel);
            // Mirror the TTS list into the secondary select used in the TTS/STT tab
            if (ttsModelSelect2) fill(ttsModelSelect2, ttsList, agent.ttsModel);
            addLog('Pobrano ' + list.length + ' modeli Gemini (' + llmList.length + ' LLM, ' + imgList.length + ' image, ' + ttsList.length + ' TTS).', 'success');
        } catch (e) {
            addLog('Gemini models error: ' + e.message, 'error');
            baseModelSelect.innerHTML = '<option value="">Błąd: ' + e.message.substring(0, 50) + '</option>';
        }
    }

    async function loadLMStudioModels(force) {
        if (!lmstudioLLMModelSelect) return;
        agent.lmstudioBaseUrl = lmstudioBaseUrlInput ? (lmstudioBaseUrlInput.value || 'http://localhost:1234') : 'http://localhost:1234';
        try {
            addLog(tr('log-fetching-lmstudio-models'), 'info');
            const list = await agent.fetchModels('lmstudio', !!force);
            lmstudioLLMModelSelect.innerHTML = '';
            if (list.length === 0) {
                lmstudioLLMModelSelect.innerHTML = '<option value="">(brak załadowanych modeli)</option>';
                return;
            }
            list.forEach(m => {
                const o = document.createElement('option');
                o.value = m.id;
                o.textContent = m.id.length > 36 ? (m.id.substring(0, 34) + '…') : m.id;
                o.title = m.id;
                lmstudioLLMModelSelect.appendChild(o);
            });
            if (agent.lmstudioLLMModel && list.find(m => m.id === agent.lmstudioLLMModel)) {
                lmstudioLLMModelSelect.value = agent.lmstudioLLMModel;
            }
            addLog('LM Studio: ' + list.length + ' modeli.', 'success');
        } catch (e) {
            addLog('LM Studio error: ' + e.message, 'error');
            lmstudioLLMModelSelect.innerHTML = '<option value="">Błąd: ' + e.message.substring(0, 60) + '</option>';
        }
    }

    const refreshGeminiBtn = document.getElementById('refresh-gemini-models');
    if (refreshGeminiBtn) refreshGeminiBtn.addEventListener('click', () => loadGeminiModels(true));
    const refreshGeminiImgBtn = document.getElementById('refresh-gemini-img-models');
    if (refreshGeminiImgBtn) refreshGeminiImgBtn.addEventListener('click', () => loadGeminiModels(true));
    const refreshLMStudioBtn = document.getElementById('refresh-lmstudio-models');
    if (refreshLMStudioBtn) refreshLMStudioBtn.addEventListener('click', () => loadLMStudioModels(true));

    // Update sandbox info display
    function refreshSandboxInfo() {
        try {
            const root = agent.getPythonSandboxRoot();
            sandboxCurrentPath.textContent = '📁 ' + root;
            const fsNode = require('fs');
            if (fsNode.existsSync(root)) {
                const dirs = fsNode.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
                sandboxCurrentEnvs.textContent = 'Środowisk venv: ' + dirs.length + (dirs.length ? ' (' + dirs.slice(0, 5).map(d => d.name).join(', ') + (dirs.length > 5 ? '...' : '') + ')' : '');
            } else {
                sandboxCurrentEnvs.textContent = '(folder zostanie utworzony przy pierwszym użyciu)';
            }
        } catch (e) {
            sandboxCurrentEnvs.textContent = '(błąd: ' + e.message + ')';
        }
    }

    // Browse buttons for sandbox paths (CEP file dialog via Node)
    function pickFolder(currentPath) {
        return new Promise((resolve) => {
            try {
                const csi = new CSInterface();
                // Use AE's host script — but we want a folder picker. Use CEP's Window.choose via JSXBin alternative
                csi.evalScript('(function(){var f=Folder.selectDialog("Wybierz folder dla środowisk Python"); return f ? f.fsName : "";})()', (res) => {
                    resolve(res && res !== 'null' && res !== '' ? res : null);
                });
            } catch (e) { resolve(null); }
        });
    }
    const browseSandboxBtn = document.getElementById('browse-sandbox-path');
    if (browseSandboxBtn) browseSandboxBtn.addEventListener('click', async () => {
        const picked = await pickFolder(pythonSandboxPathInput.value);
        if (picked) {
            pythonSandboxPathInput.value = picked;
            addLog('Wybrano sandbox: ' + picked, 'info');
        }
    });
    const browseCacheBtn = document.getElementById('browse-cache-path');
    if (browseCacheBtn) browseCacheBtn.addEventListener('click', async () => {
        const picked = await pickFolder(toolsCachePathInput.value);
        if (picked) { toolsCachePathInput.value = picked; }
    });

    // ---- OpenRouter Model Picker --------------------------------------
    const orPickerOverlay = document.getElementById('openrouter-picker-overlay');
    const orListEl = document.getElementById('openrouter-models-list');
    const orStatusEl = document.getElementById('openrouter-list-status');
    const orSearch = document.getElementById('or-search');
    const orSort = document.getElementById('or-sort');
    const orProviderFilter = document.getElementById('or-provider-filter');
    const orFeatImage = document.getElementById('or-feat-image');
    const orFeatTools = document.getElementById('or-feat-tools');
    const orFeatJson = document.getElementById('or-feat-json');
    const orFeatFree = document.getElementById('or-feat-free');
    const orFeatImgOut = document.getElementById('or-feat-imgout');
    let orModelsCache = [];
    let orPickedModelId = null;
    let orPickerTarget = 'llm'; // 'llm' or 'image'

    async function openOpenRouterPicker(target) {
        orPickerTarget = target || 'llm';
        orPickerOverlay.classList.remove('hidden');
        if (orModelsCache.length === 0) await loadOpenRouterCatalog(false);
        orPickedModelId = (target === 'image') ? agent.openrouterImageModel : agent.openrouterLLMModel;
        // For image picker, default-enable imageOutput filter
        if (target === 'image') { orFeatImgOut.checked = true; }
        renderOpenRouterList();
    }
    async function loadOpenRouterCatalog(force) {
        try {
            orStatusEl.textContent = 'Pobieram katalog OpenRouter...';
            orListEl.innerHTML = '';
            // OpenRouter listing is public; use current API key if present
            agent.openrouterApiKey = openrouterApiInput ? openrouterApiInput.value.trim() : agent.openrouterApiKey;
            const list = await agent.fetchModels('openrouter', !!force);
            orModelsCache = list;
            // Populate provider filter (unique providers, alphabetical)
            const providers = Array.from(new Set(list.map(m => m.providerName))).sort();
            orProviderFilter.innerHTML = '<option value="">Wszyscy dostawcy</option>';
            providers.forEach(p => {
                const o = document.createElement('option');
                o.value = p; o.textContent = p;
                orProviderFilter.appendChild(o);
            });
            orStatusEl.textContent = 'Załadowano ' + list.length + ' modeli OpenRouter.';
            renderOpenRouterList();
        } catch (e) {
            orStatusEl.textContent = 'Błąd: ' + e.message;
            addLog('OpenRouter catalog error: ' + e.message, 'error');
        }
    }
    function renderOpenRouterList() {
        let filtered = orModelsCache.slice();
        const q = (orSearch.value || '').toLowerCase().trim();
        const pf = orProviderFilter.value;
        if (q) filtered = filtered.filter(m => (m.id + ' ' + m.name + ' ' + m.description).toLowerCase().indexOf(q) !== -1);
        if (pf) filtered = filtered.filter(m => m.providerName === pf);
        if (orFeatImage.checked) filtered = filtered.filter(m => m.features && m.features.vision);
        if (orFeatTools.checked) filtered = filtered.filter(m => m.features && m.features.tools);
        if (orFeatJson.checked) filtered = filtered.filter(m => m.features && m.features.json);
        if (orFeatFree.checked) filtered = filtered.filter(m => m.isFree);
        if (orFeatImgOut.checked) filtered = filtered.filter(m => m.features && m.features.imageOutput);

        // Sort
        const sortBy = orSort.value;
        filtered.sort((a, b) => {
            if (sortBy === 'price-asc') return (a.pricing.promptPerMTok + a.pricing.completionPerMTok)
                                              - (b.pricing.promptPerMTok + b.pricing.completionPerMTok);
            if (sortBy === 'price-desc') return (b.pricing.promptPerMTok + b.pricing.completionPerMTok)
                                              - (a.pricing.promptPerMTok + a.pricing.completionPerMTok);
            if (sortBy === 'name') return (a.name || a.id).localeCompare(b.name || b.id);
            if (sortBy === 'context-desc') return (b.contextLength || 0) - (a.contextLength || 0);
            if (sortBy === 'new') return (b.raw && b.raw.created ? b.raw.created : 0) - (a.raw && a.raw.created ? a.raw.created : 0);
            return 0;
        });

        orListEl.innerHTML = '';
        if (filtered.length === 0) {
            orListEl.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-secondary);">Brak modeli pasujących do filtrów.</div>';
            return;
        }
        orStatusEl.textContent = 'Pokazano ' + filtered.length + ' z ' + orModelsCache.length + ' modeli.';
        filtered.slice(0, 250).forEach(m => {
            const row = document.createElement('div');
            row.className = 'or-model-row';
            if (m.id === orPickedModelId) row.classList.add('picked');
            const priceP = m.pricing.promptPerMTok.toFixed(2);
            const priceC = m.pricing.completionPerMTok.toFixed(2);
            const ctx = m.contextLength ? (m.contextLength >= 1000000 ? (m.contextLength / 1000000).toFixed(1) + 'M' : (m.contextLength / 1000).toFixed(0) + 'k') : '?';
            const badges = [];
            if (m.isFree) badges.push('<span class="badge free">FREE</span>');
            if (m.features.vision) badges.push('<span class="badge feat">Vision</span>');
            if (m.features.tools) badges.push('<span class="badge feat">Tools</span>');
            if (m.features.json) badges.push('<span class="badge feat">JSON</span>');
            if (m.features.imageOutput) badges.push('<span class="badge feat">Image-out</span>');
            const shortName = m.name && m.name.length > 36 ? m.name.substring(0, 34) + '…' : m.name;
            row.innerHTML = `
                <div class="or-model-head">
                    <div class="or-model-name" title="${escapeHtml(m.name)}">${escapeHtml(shortName)}</div>
                    <div class="or-model-id" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</div>
                </div>
                <div class="or-model-meta">
                    <span title="Cena za 1M tokenów wejście / wyjście">💲 in $${priceP} / out $${priceC} / 1M tok</span>
                    <span title="Długość kontekstu">📐 ${ctx}</span>
                    ${badges.join(' ')}
                </div>
                ${m.description ? '<div class="or-model-desc">' + escapeHtml(m.description.substring(0, 200)) + (m.description.length > 200 ? '...' : '') + '</div>' : ''}
            `;
            row.addEventListener('click', () => {
                orPickedModelId = m.id;
                Array.from(orListEl.children).forEach(c => c.classList.remove('picked'));
                row.classList.add('picked');
            });
            orListEl.appendChild(row);
        });
    }
    function escapeHtml(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    ['change', 'input'].forEach(ev => {
        [orSearch, orSort, orProviderFilter, orFeatImage, orFeatTools, orFeatJson, orFeatFree, orFeatImgOut].forEach(el => {
            if (el) el.addEventListener(ev, renderOpenRouterList);
        });
    });
    const closeOrPicker = document.getElementById('close-openrouter-picker');
    if (closeOrPicker) closeOrPicker.addEventListener('click', () => orPickerOverlay.classList.add('hidden'));
    const reloadOrBtn = document.getElementById('reload-openrouter-list');
    if (reloadOrBtn) reloadOrBtn.addEventListener('click', () => loadOpenRouterCatalog(true));
    const applyOrPick = document.getElementById('apply-openrouter-pick');
    if (applyOrPick) applyOrPick.addEventListener('click', () => {
        if (!orPickedModelId) { addLog(tr('log-voice-pick-empty'), 'warning'); return; }
        if (orPickerTarget === 'image') {
            openrouterImgModelInput.value = orPickedModelId;
        } else if (orPickerTarget === 'grounding') {
            if (openrouterGroundingModelInput) openrouterGroundingModelInput.value = orPickedModelId;
        } else {
            openrouterLLMModelInput.value = orPickedModelId;
        }
        orPickerOverlay.classList.add('hidden');
        addLog('Selected OpenRouter model: ' + orPickedModelId, 'success');
    });
    const pickOrLLM = document.getElementById('pick-openrouter-llm');
    if (pickOrLLM) pickOrLLM.addEventListener('click', () => openOpenRouterPicker('llm'));
    const pickOrGrounding = document.getElementById('pick-openrouter-grounding');
    if (pickOrGrounding) pickOrGrounding.addEventListener('click', () => openOpenRouterPicker('grounding'));
    const pickOrImg = document.getElementById('pick-openrouter-img');
    if (pickOrImg) pickOrImg.addEventListener('click', () => openOpenRouterPicker('image'));

    // Load Gemini models when settings open and key exists
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            refreshSandboxInfo();
            initElevenLabsUI();
            renderFeatureFlagsUI();
            renderToolsQuickList();
            renderPermissionRules();
            updateMcpUI();
            // Lazy-load Gemini models when settings open (cached for 15 min)
            if (agent.apiKey && baseModelSelect.options.length <= 1) {
                loadGeminiModels(false);
            }
            // For LM Studio tab: only auto-fetch if user already picked it as provider
            if (agent.llmProvider === 'lmstudio' && lmstudioLLMModelSelect && lmstudioLLMModelSelect.options.length <= 1) {
                loadLMStudioModels(false);
            }
            // For ElevenLabs: load models if provider active
            if (agent.ttsProvider === 'elevenlabs' && agent.elevenlabsApiKey && elModelSelect && elModelSelect.options.length <= 1) {
                loadElevenLabsModels(false);
            }
        });
    }

    // Initial greeting
    setTimeout(() => {
        const lang = (uiLangSelect.value === 'auto' && navigator.language.startsWith('pl')) ? 'pl' : (i18nDict[uiLangSelect.value] ? uiLangSelect.value : 'en');
        appendMessage('assistant', i18nDict[lang]['greeting'] || tr('greeting'));
        // First-run hint when no key is configured
        if (!agent.apiKey && !agent.openrouterApiKey && agent.llmProvider !== 'lmstudio') {
            setTimeout(() => {
                appendMessage('system', tr('first-run-hint'));
            }, 800);
        }
    }, 500);

    // Auto resize textarea
    promptInput.addEventListener('input', function() {
        this.style.height = '38px';
        const newHeight = Math.min(this.scrollHeight, 120);
        this.style.height = newHeight + 'px';
        if (this.scrollHeight > 120) {
            this.style.overflowY = 'auto';
        } else {
            this.style.overflowY = 'hidden';
        }
    });

    // Enter to send
    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    sendBtn.addEventListener('click', handleSend);
    stopBtn.addEventListener('click', () => {
        if (isAgentProcessing) {
            agent.abortProcess();
            stopBtn.classList.add('hidden');
            sendBtn.classList.remove('hidden');
            addLog(tr('log-stop-signal-sent'), "warning");
            updateStatus(tr('status-aborting'));
        }
    });

    // Log Console Toggle
    logConsoleToggle.addEventListener('click', () => {
        logConsole.classList.toggle('hidden');
        chevron.classList.toggle('open');
    });

    // Settings listeners
    settingsBtn.addEventListener('click', () => {
        settingsOverlay.classList.remove('hidden');
    });

    closeSettingsBtn.addEventListener('click', () => {
        settingsOverlay.classList.add('hidden');
    });

    // Attachment listeners
    let currentAttachments = [];
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const attachmentPreview = document.getElementById('attachment-preview');
    const attachmentThumb = document.getElementById('attachment-thumb');
    const removeAttachmentBtn = document.getElementById('remove-attachment-btn');

    function renderAttachmentPreviews() {
        if (currentAttachments.length === 0) {
            attachmentPreview.classList.add('hidden');
            attachmentThumb.src = '';
            return;
        }
        const container = attachmentPreview;
        container.classList.remove('hidden');
        container.querySelectorAll('.att-thumb').forEach(el => el.remove());
        currentAttachments.forEach((att, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'att-thumb';
            wrap.style.cssText = 'position:relative; display:inline-block; margin-right:4px;';
            
            const isImage = att.mimeType && att.mimeType.startsWith('image/');
            const isAudio = att.mimeType && att.mimeType.startsWith('audio/');
            const isVideo = att.mimeType && att.mimeType.startsWith('video/');
            const isPDF = att.mimeType && att.mimeType.includes('pdf');
            
            let display;
            if (isImage) {
                display = document.createElement('img');
                display.src = att.dataUri;
                display.style.cssText = 'width:48px; height:48px; object-fit:cover; border-radius:6px; border:1px solid rgba(255,255,255,0.1);';
            } else {
                display = document.createElement('div');
                let icon = '📄';
                if (isAudio) icon = '🎵';
                else if (isVideo) icon = '🎬';
                else if (isPDF) icon = '📕';
                const name = att.fileName || att.mimeType.split('/')[1] || 'file';
                display.innerHTML = icon + '<br><span style="font-size:8px;opacity:0.7;">' + name.substring(0, 8) + '</span>';
                display.style.cssText = 'width:48px; height:48px; display:flex; flex-direction:column; align-items:center; justify-content:center; border-radius:6px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05); font-size:20px; text-align:center;';
            }
            
            const del = document.createElement('span');
            del.textContent = '\u00d7';
            del.style.cssText = 'position:absolute; top:-4px; right:-2px; background:rgba(0,0,0,0.7); color:#ff4a4a; font-size:14px; width:16px; height:16px; line-height:16px; text-align:center; border-radius:50%; cursor:pointer;';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                currentAttachments.splice(idx, 1);
                renderAttachmentPreviews();
            });
            wrap.appendChild(display);
            wrap.appendChild(del);
            container.insertBefore(wrap, removeAttachmentBtn);
        });
        attachmentThumb.style.display = 'none';
    }


    if (attachBtn && fileInput) {
        fileInput.setAttribute('multiple', 'true');
        attachBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            Array.from(e.target.files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    // Detect mime for files the browser may not recognize
                    let mime = file.type;
                    if (!mime || mime === 'application/octet-stream') {
                        const ext = file.name.split('.').pop().toLowerCase();
                        const mimeMap = {
                            'jsx': 'text/plain', 'py': 'text/plain', 'srt': 'text/plain',
                            'md': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
                            'xml': 'text/xml', 'txt': 'text/plain', 'js': 'text/plain',
                            'ts': 'text/plain', 'css': 'text/plain', 'html': 'text/html',
                            'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
                            'flac': 'audio/flac', 'aac': 'audio/aac', 'm4a': 'audio/mp4',
                            'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
                            'avi': 'video/x-msvideo', 'pdf': 'application/pdf',
                            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                            'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp'
                        };
                        mime = mimeMap[ext] || 'application/octet-stream';
                    }
                    currentAttachments.push({
                        mimeType: mime,
                        data: ev.target.result.split(',')[1],
                        dataUri: ev.target.result,
                        fileName: file.name
                    });
                    renderAttachmentPreviews();
                };
                reader.readAsDataURL(file);

            });
            fileInput.value = '';
        });
        removeAttachmentBtn.addEventListener('click', () => {
            currentAttachments = [];
            renderAttachmentPreviews();
        });
    }

    // Clipboard paste image support (Ctrl+V)
    promptInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                e.preventDefault();
                const blob = items[i].getAsFile();
                const reader = new FileReader();
                reader.onload = (ev) => {
                    currentAttachments.push({
                        mimeType: blob.type || 'image/png',
                        data: ev.target.result.split(',')[1],
                        dataUri: ev.target.result
                    });
                    renderAttachmentPreviews();
                };
                reader.readAsDataURL(blob);
                break;
            }
        }
    });

    // Drag-and-drop support on the entire panel
    const appPanel = document.getElementById('app');
    if (appPanel && attachBtn) {
        ['dragenter', 'dragover'].forEach(evt => {
            appPanel.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                attachBtn.style.color = 'var(--accent)';
                attachBtn.style.transform = 'scale(1.3)';
                attachBtn.style.filter = 'drop-shadow(0 0 6px var(--accent))';
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            appPanel.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                attachBtn.style.color = '';
                attachBtn.style.transform = '';
                attachBtn.style.filter = '';
            });
        });
        appPanel.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                Array.from(files).forEach(file => {
                    // Detect mime for all Gemini-compatible file types
                    let mime = file.type;
                    if (!mime || mime === 'application/octet-stream' || mime === '') {
                        const ext = file.name.split('.').pop().toLowerCase();
                        const mimeMap = {
                            'jsx': 'text/plain', 'py': 'text/plain', 'srt': 'text/plain',
                            'md': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
                            'xml': 'text/xml', 'txt': 'text/plain', 'js': 'text/plain',
                            'ts': 'text/plain', 'css': 'text/plain', 'html': 'text/html',
                            'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
                            'flac': 'audio/flac', 'aac': 'audio/aac', 'm4a': 'audio/mp4',
                            'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
                            'avi': 'video/x-msvideo', 'pdf': 'application/pdf',
                            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                            'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp'
                        };
                        mime = mimeMap[ext] || 'application/octet-stream';
                    }
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        currentAttachments.push({
                            mimeType: mime,
                            data: ev.target.result.split(',')[1],
                            dataUri: ev.target.result,
                            fileName: file.name
                        });
                        renderAttachmentPreviews();
                    };
                    reader.readAsDataURL(file);
                });
            }
        });
    }

    // Memory listeners
    const memoryBtn = document.getElementById('memory-btn');
    const memoryOverlay = document.getElementById('memory-overlay');
    const closeMemoryBtn = document.getElementById('close-memory-btn');
    const memoryList = document.getElementById('memory-list');
    const newMemoryInput = document.getElementById('new-memory-input');
    const addMemoryBtn = document.getElementById('add-memory-btn');

    if (memoryBtn) {
        memoryBtn.addEventListener('click', () => {
            memoryOverlay.classList.remove('hidden');
            renderMemoryList();
        });
        closeMemoryBtn.addEventListener('click', () => {
            memoryOverlay.classList.add('hidden');
        });
        addMemoryBtn.addEventListener('click', () => {
            const text = newMemoryInput.value.trim();
            if (text) {
                agent.longTermMemory.push({ id: Date.now() + Math.random(), type: 'user_preference', content: text });
                window.diskStorage.setItem('aisist_memory_arr', JSON.stringify(agent.longTermMemory));
                newMemoryInput.value = '';
                renderMemoryList();
                addLog(tr('log-ltm-rule-added'), 'success');
            }
        });
        
        newMemoryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addMemoryBtn.click();
        });
    }

    function renderMemoryList() {
        if (!memoryList) return;
        memoryList.innerHTML = '';
        if (!agent.longTermMemory || agent.longTermMemory.length === 0) {
            memoryList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; text-align:center; padding: 1rem 0;">Brak zapisanych reguł w pamięci LTM.</div>';
            return;
        }
        agent.longTermMemory.forEach(m => {
            const div = document.createElement('div');
            div.className = 'memory-item';
            div.innerHTML = `
                <div class="memory-item-content"><strong>[${m.type === 'error_fix' ? 'NAPRAWA' : 'PREFERENCJA'}]</strong> ${m.content}</div>
                <button class="memory-item-del" title="Usuń z pamięci">✕</button>
            `;
            div.querySelector('.memory-item-del').addEventListener('click', () => {
                agent.longTermMemory = agent.longTermMemory.filter(item => item.id !== m.id);
                window.diskStorage.setItem('aisist_memory_arr', JSON.stringify(agent.longTermMemory));
                renderMemoryList();
                addLog(tr('log-ltm-rule-deleted'), 'info');
            });
            memoryList.appendChild(div);
        });
    }


    // --- Custom Secrets ---
    const secretsListEl = document.getElementById('custom-secrets-list');
    const secretNameInput = document.getElementById('secret-name-input');
    const secretKeyInput = document.getElementById('secret-key-input');
    const addSecretBtn = document.getElementById('add-secret-btn');

    function renderCustomSecrets() {
        if (!secretsListEl) return;
        secretsListEl.innerHTML = '';
        if (!agent.customSecrets || agent.customSecrets.length === 0) {
            secretsListEl.innerHTML = '<div style="color:var(--text-secondary); font-size:11px; text-align:center; padding:0.3rem;">Brak kluczy.</div>';
            return;
        }
        agent.customSecrets.forEach((s, idx) => {
            const div = document.createElement('div');
            div.className = 'memory-item';
            div.innerHTML = `
                <div class="memory-item-content"><strong>${s.name}</strong> <span style="color:var(--text-secondary);">••••${s.key.slice(-4)}</span></div>
                <button class="memory-item-del" title="Usuń klucz">✕</button>
            `;
            div.querySelector('.memory-item-del').addEventListener('click', () => {
                agent.customSecrets.splice(idx, 1);
                window.diskStorage.setItem('aisist_custom_secrets', JSON.stringify(agent.customSecrets));
                renderCustomSecrets();
            });
            secretsListEl.appendChild(div);
        });
    }

    if (addSecretBtn) {
        addSecretBtn.addEventListener('click', () => {
            const name = secretNameInput.value.trim();
            const key = secretKeyInput.value.trim();
            if (name && key) {
                agent.customSecrets.push({ name, key });
                window.diskStorage.setItem('aisist_custom_secrets', JSON.stringify(agent.customSecrets));
                secretNameInput.value = '';
                secretKeyInput.value = '';
                renderCustomSecrets();
                addLog(`Dodano Custom API Key: ${name}`, 'success');
            }
        });
    }

    // Load secrets on settings open
    const origSettingsClick = settingsBtn ? settingsBtn.onclick : null;
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            renderCustomSecrets();
        });
    }

    // --- Skills System ---
    const skillsBtn = document.getElementById('skills-btn');
    const skillsOverlay = document.getElementById('skills-overlay');
    const closeSkillsBtn = document.getElementById('close-skills-btn');
    const skillsList = document.getElementById('skills-list');
    const newSkillName = document.getElementById('new-skill-name');
    const addSkillBtn = document.getElementById('add-skill-btn');

    function renderSkillsList() {
        if (!skillsList) return;
        agent.skills = agent.loadSkills();
        skillsList.innerHTML = '';
        if (agent.skills.length === 0) {
            skillsList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; text-align:center; padding: 1rem 0;">Brak zapisanych skilli.<br><span style="font-size:10px;">Agent automatycznie zapisuje skille po udanych zadaniach.</span></div>';
            return;
        }
        agent.skills.forEach(s => {
            const div = document.createElement('div');
            div.className = 'session-item';
            div.innerHTML = `
                <div style="flex: 1; min-width: 0; cursor: pointer;">
                    <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.title || s.name}</div>
                    <div class="session-date">${s.date}${s.projectName ? " | " + s.projectName : ""}</div>
                </div>
                <button class="session-item-del" title="Usuń skill" style="background:transparent; border:none; color:rgba(255,255,255,0.3); padding:4px 8px; cursor:pointer; font-size:14px; transition:color 0.2s; flex-shrink:0;">✕</button>
            `;
            const delBtn = div.querySelector('.session-item-del');
            delBtn.addEventListener('mouseenter', () => delBtn.style.color = '#ff4a4a');
            delBtn.addEventListener('mouseleave', () => delBtn.style.color = 'rgba(255,255,255,0.3)');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                agent.deleteSkill(s.name);
                renderSkillsList();
                addLog(tr('log-skill-deleted').replace('{name}', s.name), 'info');
            });
            div.firstElementChild.addEventListener('click', () => {
                // Show skill content in a simple alert-like overlay
                const content = s.content.length > 500 ? s.content.substring(0, 500) + '...' : s.content;
                appendMessage('assistant', `**Skill: ${s.name}**\n\n${content}`);
                skillsOverlay.classList.add('hidden');
            });
            skillsList.appendChild(div);
        });
    }

    if (skillsBtn) {
        skillsBtn.addEventListener('click', () => {
            skillsOverlay.classList.remove('hidden');
            renderSkillsList();
        });
    }
    if (closeSkillsBtn) {
        closeSkillsBtn.addEventListener('click', () => {
            skillsOverlay.classList.add('hidden');
        });
    }
    if (addSkillBtn) {
        addSkillBtn.addEventListener('click', () => {
            const name = newSkillName.value.trim();
            if (name) {
                const defaultContent = `# ${name}\n\nOpis przepisu / techniki...\n\n## Kroki\n1. ...\n2. ...\n`;
                agent.saveSkill(name, defaultContent);
                newSkillName.value = '';
                renderSkillsList();
                addLog(`Utworzono nowy skill: ${name}`, 'success');
            }
        });
    }
    sessionsBtn.addEventListener('click', () => {
        sessionsOverlay.classList.remove('hidden');
        renderSessions();
    });

    closeSessionsBtn.addEventListener('click', () => {
        sessionsOverlay.classList.add('hidden');
    });

    function loadSession(id) {
        const sessions = JSON.parse(window.diskStorage.getItem('aisist_sessions') || '{}');
        if (sessions[id]) {
            currentSessionId = sessions[id].id;
            agent.history = sessions[id].history || [];
            chatContainer.innerHTML = sessions[id].html || '';
            chatContainer.scrollTop = chatContainer.scrollHeight;
            sessionsOverlay.classList.add('hidden');
            addLog(tr('log-loaded-session').replace('{date}', sessions[id].date), 'info');
        }
    }

    function saveSession() {
        let sessions = JSON.parse(window.diskStorage.getItem('aisist_sessions') || '{}');
        let title = "Rozpoczęto nową sesję...";
        if (agent.history && agent.history.length > 0) {
            const firstUserMsg = agent.history.find(p => p.role === 'user');
            if (firstUserMsg && firstUserMsg.parts && firstUserMsg.parts[0] && firstUserMsg.parts[0].text) {
                let textObj = firstUserMsg.parts[0].text;
                let splitObj = textObj.split('KOMUNIKAT LUB ZADANIE:\n');
                let rawText = splitObj.length > 1 ? splitObj[1].trim() : textObj.trim();
                let stripImgText = rawText.split('\n[Załączono')[0].trim();
                title = stripImgText.length > 35 ? stripImgText.substring(0, 35) + '...' : stripImgText;
            }
        }
        sessions[currentSessionId] = {
            id: currentSessionId,
            date: new Date().toLocaleString('pl-PL'),
            title: title,
            projectName: currentWorkingProject || 'unknown',
            history: agent.history,
            html: chatContainer.innerHTML
        };
        window.diskStorage.setItem('aisist_sessions', JSON.stringify(sessions));
    }

    function renderSessions() {
        sessionsList.innerHTML = '';
        const sessions = JSON.parse(window.diskStorage.getItem('aisist_sessions') || '{}');
        const sorted = Object.values(sessions).sort((a,b) => b.id - a.id);
        
        if (sorted.length === 0) {
            sessionsList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; text-align:center; padding: 1rem 0;">Brak zapisanych sesji.</div>';
            return;
        }

        sorted.forEach(s => {
            const div = document.createElement('div');
            div.className = 'session-item';
            if (s.id === currentSessionId) {
                div.style.borderColor = 'var(--accent)';
                div.style.background = 'rgba(204, 166, 93, 0.15)';
            }
            div.innerHTML = `
                <div style="flex: 1; min-width: 0; cursor: pointer;">
                    <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.title}</div>
                    <div class="session-date">${s.date}</div>
                </div>
                <button class="session-item-del" title="Usuń sesję" style="background:transparent; border:none; color:rgba(255,255,255,0.3); padding:4px 8px; cursor:pointer; font-size:14px; transition:color 0.2s; flex-shrink:0;">✕</button>
            `;
            
            // Hover effect for del btn
            const delBtn = div.querySelector('.session-item-del');
            delBtn.addEventListener('mouseenter', () => delBtn.style.color = '#ff4a4a');
            delBtn.addEventListener('mouseleave', () => delBtn.style.color = 'rgba(255,255,255,0.3)');
            
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                let confirmDel = true;
                try { confirmDel = confirm('Czy na pewno chcesz trwale usunąć tę konwersację?'); } catch(err) {}
                if (confirmDel) {
                    const currentSessions = JSON.parse(window.diskStorage.getItem('aisist_sessions') || '{}');
                    delete currentSessions[s.id];
                    window.diskStorage.setItem('aisist_sessions', JSON.stringify(currentSessions));
                    renderSessions();
                    addLog(tr('log-deleted-session').replace('{date}', s.date), 'info');
                    if (currentSessionId === s.id) {
                        newSessionBtn.click();
                    }
                }
            });

            div.firstElementChild.addEventListener('click', () => {
                currentSessionId = s.id;
                agent.history = s.history || [];
                chatContainer.innerHTML = s.html || '';
                chatContainer.scrollTop = chatContainer.scrollHeight;
                sessionsOverlay.classList.add('hidden');
                addLog(tr('log-loaded-session').replace('{date}', s.date), 'info');
            });
            sessionsList.appendChild(div);
        });
    }

    newSessionBtn.addEventListener('click', () => {
        currentSessionId = Date.now().toString();
        agent.history = [];
        chatContainer.innerHTML = `
            <div class="message assistant">
                <div class="message-content">
                    <div>Rozpoczęto nową sesję! W czym mogę dziś pomóc? ✦</div>
                </div>
            </div>`;
        saveSession();
        sessionsOverlay.classList.add('hidden');
        addLog(tr('log-new-session-created'), 'success');
    });

    saveSettingsBtn.addEventListener('click', () => {
        // Build feature flags object from checkbox states
        const newFlags = {};
        document.querySelectorAll('input[data-feature]').forEach(cb => {
            newFlags[cb.getAttribute('data-feature')] = cb.checked;
        });
        // Get TTS model from secondary select if available (TTS tab)
        const effTtsModel = (ttsModelSelect2 && ttsModelSelect2.value) || ttsModelSelect.value;
        agent.setCredentials({
            apiKey: apiKeyInput.value.trim(),
            openrouterApiKey: openrouterApiInput ? openrouterApiInput.value.trim() : '',
            replicateApiKey: replicateApiInput.value.trim(),
            elevenlabsApiKey: elevenlabsApiInput.value.trim(),
            llmProvider: llmProviderSelect ? llmProviderSelect.value : 'gemini',
            imgProvider: imgProviderSelect ? imgProviderSelect.value : 'gemini',
            geminiModel: baseModelSelect.value,
            geminiImageModel: imageModelSelect.value,
            openrouterLLMModel: openrouterLLMModelInput ? openrouterLLMModelInput.value.trim() : '',
            openrouterGroundingModel: openrouterGroundingModelInput ? openrouterGroundingModelInput.value.trim() : '',
            openrouterImageModel: openrouterImgModelInput ? openrouterImgModelInput.value.trim() : '',
            lmstudioLLMModel: lmstudioLLMModelSelect ? lmstudioLLMModelSelect.value : '',
            lmstudioBaseUrl: lmstudioBaseUrlInput ? lmstudioBaseUrlInput.value.trim() : 'http://localhost:1234',
            ttsModel: effTtsModel,
            ttsVoice: ttsVoiceSelect.value,
            uiLang: uiLangSelect.value,
            projLang: projLangSelect.value,
            useGrounding: useGroundingCheck.checked,
            pythonSandboxPath: pythonSandboxPathInput ? pythonSandboxPathInput.value.trim() : '',
            toolsCachePath: toolsCachePathInput ? toolsCachePathInput.value.trim() : '',
            // TTS / STT / ElevenLabs
            ttsProvider: ttsProviderSelect ? ttsProviderSelect.value : 'gemini',
            sttProvider: sttProviderSelect ? sttProviderSelect.value : 'elevenlabs',
            musicProvider: musicProviderSelect ? musicProviderSelect.value : 'gemini',
            elevenlabsSfxPromptInfluence: sfxInfluence ? +sfxInfluence.value : 0.3,
            elevenlabsSfxDefaultDuration: sfxDefaultDuration ? +sfxDefaultDuration.value : 0,
            elevenlabsMusicForceInstrumental: elMusicInstr ? elMusicInstr.checked : true,
            elevenlabsModel: elModelSelect ? elModelSelect.value : 'eleven_multilingual_v2',
            elevenlabsSttModel: elSttModelSelect ? elSttModelSelect.value : 'scribe_v2',
            elevenlabsOutputFormat: elOutputFormat ? elOutputFormat.value : 'mp3_44100_128',
            elevenlabsDefaultVoice: elDefaultVoiceInput ? elDefaultVoiceInput.value : '',
            elevenlabsMaleVoice: elMaleVoiceInput ? elMaleVoiceInput.value : '',
            elevenlabsFemaleVoice: elFemaleVoiceInput ? elFemaleVoiceInput.value : '',
            elevenlabsUseGeneralDefault: elUseGeneralDefault ? elUseGeneralDefault.checked : false,
            elevenlabsVoiceSettings: {
                stability: elStability ? +elStability.value : 0.5,
                similarity_boost: elSimilarity ? +elSimilarity.value : 0.75,
                style: elStyle ? +elStyle.value : 0,
                use_speaker_boost: elSpeakerBoost ? elSpeakerBoost.checked : true
            },
            featureFlags: Object.keys(newFlags).length > 0 ? newFlags : undefined
        });
        settingsOverlay.classList.add('hidden');
        applyTranslations(uiLangSelect.value);
        appendMessage('system', tr('settings-saved-toast')
            .replace('{llm}', agent.llmProvider)
            .replace('{model}', agent.getActiveLLMModel() || '—')
            .replace('{img}', agent.imgProvider)
            .replace('{tts}', agent.ttsProvider));
    });

    function appendMessage(sender, text, thought = null, planArray = null, attachedImageUri = null) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${sender}`;
        
        const msgContent = document.createElement('div');
        msgContent.className = 'message-content';
        
        if (thought) {
            const thoughtDetails = document.createElement('details');
            thoughtDetails.className = 'thought-details';
            const thoughtSummary = document.createElement('summary');
            thoughtSummary.textContent = "⚙️ Proces decyzyjny AI...";
            const thoughtContent = document.createElement('div');
            thoughtContent.className = 'thought-content';
            thoughtContent.textContent = thought;
            thoughtDetails.appendChild(thoughtSummary);
            thoughtDetails.appendChild(thoughtContent);
            msgContent.appendChild(thoughtDetails);
        }
        
        if (planArray && planArray.length > 0) {
            const planEl = document.createElement('div');
            planEl.className = 'orchestration-plan';
            planEl.style.fontSize = '12px';
            planEl.style.color = 'var(--text-secondary)';
            planEl.style.borderLeft = '2px solid var(--accent)';
            planEl.style.paddingLeft = '8px';
            planEl.style.marginBottom = '8px';
            planEl.innerHTML = `<strong>Aktualny Plan:</strong><ul style="margin-top:4px; padding-left:14px;">
                ${planArray.map(item => `<li>${item}</li>`).join('')}
            </ul>`;
            msgContent.appendChild(planEl);
        }

        if (attachedImageUri) {
            const uris = Array.isArray(attachedImageUri) ? attachedImageUri : [attachedImageUri];
            const imgWrap = document.createElement('div');
            imgWrap.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;';
            uris.forEach(uri => {
                const imgEl = document.createElement('img');
                imgEl.src = uri;
                imgEl.style.maxWidth = '120px';
                imgEl.style.maxHeight = '120px';
                imgEl.style.objectFit = 'cover';
                imgEl.style.borderRadius = '8px';
                imgEl.style.border = '1px solid rgba(255,255,255,0.1)';
                imgWrap.appendChild(imgEl);
            });
            msgContent.appendChild(imgWrap);
        }

        if (text) {
            const textDiv = document.createElement('div');
            textDiv.innerHTML = text.replace(/\n/g, '<br>');
            msgContent.appendChild(textDiv);
        }

        msgDiv.appendChild(msgContent);
        chatContainer.appendChild(msgDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function updateStatus(text, isLoading = false) {
        if (isLoading) {
            statusIndicator.innerHTML = `<span class="loader"></span> ${text}`;
        } else {
            statusIndicator.textContent = text;
        }
    }

    function addLog(msg, type = 'info') {
        const d = new Date();
        const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
        
        const logEntry = document.createElement('div');
        logEntry.innerHTML = `<span class="log-time">[${timeStr}]</span><span class="log-${type}">${msg}</span>`;
        logMessages.appendChild(logEntry);
        
        logConsole.scrollTop = logConsole.scrollHeight;
    }

    function showTyping() {
        if (document.getElementById('active-typing-indicator')) return;
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message assistant typing-indicator-msg';
        typingDiv.id = 'active-typing-indicator';
        typingDiv.innerHTML = '<div class="message-content" style="padding: 0.5rem 1rem;"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
        chatContainer.appendChild(typingDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function hideTyping() {
        const typingDiv = document.getElementById('active-typing-indicator');
        if (typingDiv) typingDiv.remove();
    }
    // Global reference so handleSend can resolve questions via chat
    let pendingQuestionResolve = null;
    let pendingQuestionCleanup = null;

    let currentWorkingProject = null;

    // ===== Live streaming thinking block ===============================
    // Shown while the LLM is producing its JSON response. Updates char-by-char
    // as SSE chunks arrive. Auto-collapses to the standard "decision process"
    // expandable detail once streaming completes.
    function createStreamingThinkingBlock() {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message assistant streaming-thinking';
        msgDiv.innerHTML = `
            <div class="message-content">
                <details class="thought-details thinking-live" open>
                    <summary>
                        <span class="thinking-pulse"></span>
                        <span class="thinking-summary-text">${escapeAttr(tr('thinking-live-label'))}</span>
                        <span class="thinking-char-count">0</span>
                    </summary>
                    <div class="thought-content thought-content-stream"></div>
                </details>
                <div class="streaming-extracted">
                    <div class="streaming-plan hidden"></div>
                    <div class="streaming-message hidden"></div>
                </div>
            </div>
        `;
        chatContainer.appendChild(msgDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        const thoughtEl = msgDiv.querySelector('.thought-content-stream');
        const charCountEl = msgDiv.querySelector('.thinking-char-count');
        const planEl = msgDiv.querySelector('.streaming-plan');
        const messageEl = msgDiv.querySelector('.streaming-message');
        const detailsEl = msgDiv.querySelector('details.thinking-live');
        let autoScroll = true;
        // Track manual collapse / scroll-up — pause auto-scroll once user interacts
        if (thoughtEl) {
            thoughtEl.addEventListener('scroll', () => {
                const atBottom = thoughtEl.scrollHeight - thoughtEl.scrollTop - thoughtEl.clientHeight < 8;
                autoScroll = atBottom;
            });
        }

        // Try to parse partial JSON on each update to extract live "thought" / "current_plan" / "message"
        // These fields appear early in the JSON in the documented response shape.
        function extractPartial(rawJson) {
            // Naive extraction — find `"field": "...` blocks and slice up to closing quote (escape-aware)
            const grab = (key) => {
                const re = new RegExp('"' + key + '"\\s*:\\s*"', 'i');
                const m = re.exec(rawJson);
                if (!m) return null;
                const start = m.index + m[0].length;
                let i = start, out = '';
                while (i < rawJson.length) {
                    const ch = rawJson[i];
                    if (ch === '\\' && i + 1 < rawJson.length) {
                        // unescape common sequences
                        const next = rawJson[i + 1];
                        if (next === 'n') out += '\n';
                        else if (next === 't') out += '\t';
                        else if (next === '"') out += '"';
                        else if (next === '\\') out += '\\';
                        else out += next;
                        i += 2; continue;
                    }
                    if (ch === '"') break;
                    out += ch;
                    i++;
                }
                return out;
            };
            // Extract current_plan as array of strings
            const grabPlan = () => {
                const m = /"current_plan"\s*:\s*\[/i.exec(rawJson);
                if (!m) return null;
                let i = m.index + m[0].length;
                const items = [];
                while (i < rawJson.length) {
                    while (i < rawJson.length && /\s/.test(rawJson[i])) i++;
                    if (rawJson[i] === ']') break;
                    if (rawJson[i] !== '"') break; // incomplete
                    i++; // skip opening "
                    let buf = '';
                    while (i < rawJson.length) {
                        const ch = rawJson[i];
                        if (ch === '\\' && i + 1 < rawJson.length) {
                            const next = rawJson[i + 1];
                            buf += (next === 'n' ? '\n' : next === '"' ? '"' : next);
                            i += 2; continue;
                        }
                        if (ch === '"') { i++; break; }
                        buf += ch; i++;
                    }
                    items.push(buf);
                    while (i < rawJson.length && /[\s,]/.test(rawJson[i])) i++;
                }
                return items;
            };
            return {
                thought: grab('thought'),
                plan: grabPlan(),
                message: grab('message')
            };
        }

        return {
            update: (delta, fullText) => {
                if (!thoughtEl) return;
                thoughtEl.textContent = fullText;
                if (charCountEl) charCountEl.textContent = fullText.length;
                if (autoScroll) thoughtEl.scrollTop = thoughtEl.scrollHeight;
                // Try to extract early fields and show them as a preview above
                try {
                    const fields = extractPartial(fullText);
                    if (fields.plan && fields.plan.length > 0 && planEl) {
                        planEl.classList.remove('hidden');
                        planEl.innerHTML = '<strong>' + escapeAttr(tr('plan-preview-label') || 'Plan') + '</strong>'
                            + '<ul>' + fields.plan.map(p => '<li>' + escapeAttr(p) + '</li>').join('') + '</ul>';
                    }
                    if (fields.message && fields.message.length > 6 && messageEl) {
                        messageEl.classList.remove('hidden');
                        messageEl.textContent = fields.message;
                    }
                } catch (_) {}
            },
            finalize: (kept = false) => {
                msgDiv.classList.add('streaming-complete');
                const pulse = msgDiv.querySelector('.thinking-pulse');
                if (pulse) pulse.remove();
                if (detailsEl) detailsEl.open = false; // collapse the thinking block by default after completion
                const labelEl = msgDiv.querySelector('.thinking-summary-text');
                if (labelEl) labelEl.textContent = tr('thinking-done-label');
                // Hide the partial preview rows — the real parsed message will be appended separately
                if (planEl) planEl.classList.add('hidden');
                if (messageEl) messageEl.classList.add('hidden');
                // Optionally keep or remove the whole block. By default we KEEP it so the user
                // can re-open and inspect raw reasoning afterwards.
                if (!kept) {
                    // Auto-remove if extremely short (likely no useful content)
                    if (thoughtEl && thoughtEl.textContent.trim().length < 20) msgDiv.remove();
                }
            },
            remove: () => msgDiv.remove(),
            node: msgDiv
        };
    }

    // ===== Drag-out: chat asset → anywhere in After Effects ============
    // After Effects accepts native OS file drops on Project panel, Timeline,
    // Composition viewer, and Footage viewer. We hook HTML5 drag events on
    // every asset preview rendered in the chat and emit the Chromium-recognised
    // "DownloadURL" data-transfer payload — AE's OS-level drop handler sees a
    // real file drag and imports correctly. Supported drop targets:
    //   • Project panel — adds the asset to the project tree
    //   • Timeline panel — adds as a new layer at the dropped position
    //   • Composition viewer — adds as layer at the drop coordinates
    //   • Folders in Project panel — places asset inside that folder
    function guessMimeFromExt(filePath) {
        const ext = (filePath || '').toLowerCase().split('.').pop();
        const map = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
            svg: 'image/svg+xml',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
            aac: 'audio/aac', m4a: 'audio/mp4', opus: 'audio/opus', aiff: 'audio/aiff',
            mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
            avi: 'video/x-msvideo',
            aep: 'application/x-aftereffects-project', aet: 'application/x-aftereffects-template'
        };
        return map[ext] || 'application/octet-stream';
    }

    function makeAssetDraggable(element, filePath, opts) {
        if (!element || !filePath) return;
        opts = opts || {};
        const normalizedPath = filePath.replace(/\\/g, '/');
        const fileName = opts.fileName || normalizedPath.split('/').pop();
        const mimeType = opts.mimeType || guessMimeFromExt(filePath);
        // Use the most-recognized URL form for AE on both Windows and macOS.
        // Chromium turns this into a true OS file drag.
        const fileUrl = 'file:///' + normalizedPath.replace(/^\/+/, '');

        element.setAttribute('draggable', 'true');
        element.classList.add('asset-draggable');
        if (!element.title) element.title = tr('drag-to-ae-hint');

        element.addEventListener('dragstart', (e) => {
            try {
                e.dataTransfer.effectAllowed = 'copy';
                // Primary signal — Chromium-specific format AE recognises as a real file drag.
                e.dataTransfer.setData('DownloadURL', mimeType + ':' + fileName + ':' + fileUrl);
                // Standard URI list — picked up by some panels and external apps.
                e.dataTransfer.setData('text/uri-list', fileUrl);
                // Fallback — raw file path for any handler that reads plain text.
                e.dataTransfer.setData('text/plain', filePath);
                element.classList.add('asset-dragging');
                addLog('Drag started: ' + fileName, 'info');
            } catch (err) {
                console.warn('Drag start failed:', err);
            }
        });
        element.addEventListener('dragend', () => {
            element.classList.remove('asset-dragging');
        });
    }

    // Render a single asset card for the chat. assetType: 'image'|'audio'|'video'|'svg'.
    // Audio subKind (tts/music/sfx) selects the icon and accent.
    function renderAssetCard(asset) {
        const card = document.createElement('div');
        card.className = 'asset-card asset-card-' + asset.type;
        const fileName = asset.fileName || (asset.filePath || '').replace(/\\/g, '/').split('/').pop();
        const safeFileUrl = 'file:///' + (asset.filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const idxBadge = (typeof asset.index === 'number') ? '<span class="asset-card-index">#' + (asset.index + 1) + '</span>' : '';

        if (asset.type === 'image' || asset.type === 'svg') {
            card.innerHTML = `
                <img src="${escapeAttr(safeFileUrl)}" alt="${escapeAttr(asset.prompt || fileName)}">
                <div class="asset-card-footer">
                    ${idxBadge}
                    <span class="asset-card-drag-hint" title="${escapeAttr(tr('drag-to-ae-hint'))}">⇲ ${escapeAttr(tr('drag-label'))}</span>
                </div>
            `;
        } else if (asset.type === 'audio') {
            const icon = asset.kind === 'tts' ? '🎙' : asset.kind === 'music' ? '🎵' : asset.kind === 'sfx' ? '🔊' : '🎧';
            const meta = asset.duration ? Math.round(asset.duration) + 's' : '';
            card.innerHTML = `
                <div class="asset-card-audio-icon">${icon}</div>
                <div class="asset-card-audio-body">
                    <div class="asset-card-audio-name">${escapeAttr(fileName)}</div>
                    <audio src="${escapeAttr(safeFileUrl)}" controls preload="metadata"></audio>
                    <div class="asset-card-audio-meta">
                        ${meta ? '<span>' + meta + '</span>' : ''}
                        ${asset.prompt ? '<span class="asset-card-prompt">' + escapeAttr(asset.prompt.substring(0, 60)) + (asset.prompt.length > 60 ? '…' : '') + '</span>' : ''}
                        <span class="asset-card-drag-hint" title="${escapeAttr(tr('drag-to-ae-hint'))}">⇲ ${escapeAttr(tr('drag-label'))}</span>
                    </div>
                </div>
            `;
        } else if (asset.type === 'video') {
            card.innerHTML = `
                <video src="${escapeAttr(safeFileUrl)}" muted preload="metadata" loop></video>
                <div class="asset-card-footer">
                    ${idxBadge}
                    ${asset.duration ? '<span class="asset-card-meta">' + Math.round(asset.duration) + 's</span>' : ''}
                    <span class="asset-card-drag-hint" title="${escapeAttr(tr('drag-to-ae-hint'))}">⇲ ${escapeAttr(tr('drag-label'))}</span>
                </div>
            `;
            // Show preview frame at 0.5s on hover
            const v = card.querySelector('video');
            if (v) {
                v.addEventListener('mouseenter', () => { try { v.play().catch(() => {}); } catch(_) {} });
                v.addEventListener('mouseleave', () => { try { v.pause(); v.currentTime = 0; } catch(_) {} });
            }
        }
        makeAssetDraggable(card, asset.filePath, { fileName: fileName, mimeType: guessMimeFromExt(asset.filePath) });
        return card;
    }

    // Append a row of asset cards as a single assistant message in the chat.
    function appendAssetGrid(assets, headerText) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message assistant';
        const content = document.createElement('div');
        content.className = 'message-content asset-grid-container';
        if (headerText) {
            const header = document.createElement('div');
            header.className = 'asset-grid-header';
            header.textContent = headerText;
            content.appendChild(header);
        }
        const grid = document.createElement('div');
        grid.className = 'asset-grid';
        assets.forEach(a => grid.appendChild(renderAssetCard(a)));
        content.appendChild(grid);
        msgDiv.appendChild(content);
        chatContainer.appendChild(msgDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Auto-applies the agent's "suggestion" field for every question after AUTO_APPLY_SECONDS,
    // unless the user clicks (focuses) any input or the chat textarea first. Designed to keep
    // the orchestrator flowing without blocking on every question — sensible defaults win.
    const AUTO_APPLY_SECONDS = 15;

    function presentQuestionsToUser(questions) {
        return new Promise((resolve) => {
            const uniqueId = Date.now() + Math.floor(Math.random() * 1000);

            const msgDiv = document.createElement('div');
            msgDiv.className = 'message assistant';

            const msgContent = document.createElement('div');
            msgContent.className = 'message-content';
            msgContent.style.borderLeft = '3px solid var(--accent)';

            const intro = document.createElement('div');
            intro.style.fontSize = '13px';
            intro.style.marginBottom = '10px';
            intro.innerHTML = '<strong>' + escapeAttr(tr('q-form-title')) + '</strong><br>'
                + '<span style="color: var(--text-secondary);">' + escapeAttr(tr('q-form-intro')) + '</span>';
            msgContent.appendChild(intro);

            const formContainer = document.createElement('div');
            formContainer.style.display = 'flex';
            formContainer.style.flexDirection = 'column';
            formContainer.style.gap = '10px';

            const suggestionLabel = tr('q-form-suggestion-label');
            const suggestionNone = tr('q-form-suggestion-none');
            const placeholderText = tr('q-form-placeholder');

            questions.forEach((q, idx) => {
                const div = document.createElement('div');
                div.style.background = 'rgba(0,0,0,0.2)';
                div.style.padding = '10px';
                div.style.borderRadius = '6px';
                div.style.border = '1px solid rgba(255,255,255,0.05)';
                div.innerHTML = `
                    <p style="margin: 0 0 6px 0; font-size: 13px; color: var(--text-primary);"><strong>${escapeAttr(q.question || '')}</strong></p>
                    <div style="font-size: 11px; margin-bottom: 6px; display:inline-block; padding: 2px 6px; background: rgba(220,163,83,0.12); color: var(--accent); border-radius: 4px;">${escapeAttr(suggestionLabel)}: ${escapeAttr(q.suggestion || suggestionNone)}</div>
                    <textarea id="q-inline-${uniqueId}-${idx}" placeholder="${escapeAttr(placeholderText)}" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 6px; padding: 6px; color: white; font-family: inherit; font-size: 13px; resize: vertical; min-height: 44px; outline: none;"></textarea>
                `;
                formContainer.appendChild(div);
            });

            const submitBtn = document.createElement('button');
            submitBtn.className = 'primary-btn';
            submitBtn.style.marginTop = '4px';
            submitBtn.style.width = '100%';
            submitBtn.style.padding = '8px';
            submitBtn.textContent = tr('q-form-submit');
            formContainer.appendChild(submitBtn);

            // Countdown badge + progress bar
            const countdownWrap = document.createElement('div');
            countdownWrap.className = 'q-form-countdown-wrap';
            countdownWrap.innerHTML = `
                <div class="q-form-countdown-label"></div>
                <div class="q-form-countdown-bar"><div class="q-form-countdown-fill"></div></div>
            `;
            formContainer.appendChild(countdownWrap);

            msgContent.appendChild(formContainer);
            msgDiv.appendChild(msgContent);
            chatContainer.appendChild(msgDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;

            let handlerCalled = false;
            let countdownInterval = null;
            let countdownCancelled = false;
            const startedAt = Date.now();
            const countdownLabel = countdownWrap.querySelector('.q-form-countdown-label');
            const countdownFill = countdownWrap.querySelector('.q-form-countdown-fill');

            const disableForm = (label, color) => {
                if (handlerCalled) return;
                handlerCalled = true;
                if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
                questions.forEach((q, idx) => {
                    const input = document.getElementById(`q-inline-${uniqueId}-${idx}`);
                    if (input) input.disabled = true;
                });
                submitBtn.disabled = true;
                submitBtn.textContent = label;
                submitBtn.style.background = 'transparent';
                submitBtn.style.border = '1px solid ' + (color || 'var(--accent)');
                submitBtn.style.color = color || 'var(--text-secondary)';
                countdownWrap.style.display = 'none';
                pendingQuestionResolve = null;
                pendingQuestionCleanup = null;
            };

            const cancelAutoApply = (reason) => {
                if (countdownCancelled || handlerCalled) return;
                countdownCancelled = true;
                if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
                countdownLabel.textContent = tr('q-form-countdown-cancelled');
                countdownLabel.classList.add('cancelled');
                countdownFill.style.transition = 'none';
                countdownFill.style.background = 'rgba(255,255,255,0.08)';
            };

            const collectAndResolve = (autoApplied) => {
                let answersText = "";
                questions.forEach((q, idx) => {
                    const input = document.getElementById(`q-inline-${uniqueId}-${idx}`);
                    let val = input ? input.value.trim() : "";
                    if (!val) val = q.suggestion || tr('q-form-no-answer-fallback');
                    answersText += 'Question: ' + (q.question || '') + '\nAnswer: ' + val + '\n\n';
                });
                disableForm(autoApplied ? tr('q-form-auto-applied') : tr('q-form-submitted'), 'var(--accent)');
                resolve(answersText.trim());
            };

            submitBtn.addEventListener('click', () => collectAndResolve(false));

            // Cancel auto-apply on ANY user interaction with the form
            questions.forEach((q, idx) => {
                const input = document.getElementById(`q-inline-${uniqueId}-${idx}`);
                if (!input) return;
                ['focus', 'click', 'input', 'keydown'].forEach(ev => input.addEventListener(ev, () => cancelAutoApply('field-interaction')));
            });
            // Cancel auto-apply when user focuses the main chat textarea (they may answer via chat)
            const chatInputCancelHandler = () => cancelAutoApply('chat-input');
            promptInput.addEventListener('focus', chatInputCancelHandler);
            promptInput.addEventListener('click', chatInputCancelHandler);
            promptInput.addEventListener('input', chatInputCancelHandler);

            // Cleanup function removes chat-input listeners when form is finalised
            const _origDisableForm = disableForm;
            // (no-op; we just rely on handlerCalled to short-circuit)

            // Start countdown
            const updateCountdown = () => {
                const elapsed = (Date.now() - startedAt) / 1000;
                const remaining = Math.max(0, AUTO_APPLY_SECONDS - elapsed);
                const pct = Math.max(0, Math.min(100, (remaining / AUTO_APPLY_SECONDS) * 100));
                countdownFill.style.width = pct + '%';
                countdownLabel.textContent = tr('q-form-countdown').replace('{n}', Math.ceil(remaining));
                if (remaining <= 0 && !handlerCalled && !countdownCancelled) {
                    collectAndResolve(true);
                }
            };
            updateCountdown();
            countdownInterval = setInterval(() => {
                if (agent.isAborted) {
                    clearInterval(countdownInterval); countdownInterval = null;
                    disableForm(tr('q-form-aborted'), 'var(--danger)');
                    resolve("[ABORT]");
                    return;
                }
                if (handlerCalled || countdownCancelled) {
                    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
                    return;
                }
                updateCountdown();
            }, 250);

            // Allow chat input text to resolve this question form
            pendingQuestionResolve = (chatText) => {
                cancelAutoApply('chat-answer');
                disableForm(tr('q-form-chat-resolved'), 'var(--accent)');
                resolve(chatText);
            };
            pendingQuestionCleanup = () => disableForm(tr('q-form-aborted'), 'var(--danger)');
        });
    }

    async function handleSend() {
        const text = promptInput.value.trim();
        if (!text && currentAttachments.length === 0) return;
        
        // If there's a pending question form, resolve it via chat input
        if (pendingQuestionResolve && text) {
            appendMessage('user', text);
            promptInput.value = '';
            promptInput.style.height = '38px';
            pendingQuestionResolve(text);
            return;
        }
        
        if (!agent.apiKey) {
            appendMessage('assistant', tr('amsg-no-api-key'));
            addLog('Brak klucza API.', 'error');
            return;
        }

        let sentAttachments = currentAttachments.map(a => ({ mimeType: a.mimeType, data: a.data }));
        let attachUris = currentAttachments.map(a => a.dataUri);
        
        appendMessage('user', text, null, null, attachUris.length > 0 ? attachUris : null);
        promptInput.value = '';
        promptInput.style.height = '38px';
        promptInput.style.overflowY = 'hidden';
        
        if (currentAttachments.length > 0) {
            currentAttachments = [];
            renderAttachmentPreviews();
        }

        if (isAgentProcessing) {
            // Analyze user intent: is this a redirect/abort or just a suggestion?
            const lowerText = text.toLowerCase();
            const abortKeywords = ['stop', 'przerwij', 'anuluj', 'cancel', 'nie tak', 'nie to', 'zacznij od nowa', 'inaczej', 'zmień', 'zamiast', 'poczekaj', 'wstrzymaj'];
            const isAbortIntent = abortKeywords.some(kw => lowerText.includes(kw));
            const isNewTask = lowerText.length > 20 && !lowerText.startsWith('tak') && !lowerText.startsWith('ok') && !lowerText.startsWith('super') && !lowerText.startsWith('dobrze');
            
            if (isAbortIntent || isNewTask) {
                // Abort current operations and redirect
                addLog(tr('log-user-interrupting').replace('{text}', text.substring(0, 50) + '...'), 'warning');
                sfx.warning();
                agent.isAborted = true;
                if (agent.abortController) agent.abortController.abort();
                
                // Kill any running Python processes
                if (agent.backgroundProcesses) {
                    Object.keys(agent.backgroundProcesses).forEach(name => {
                        const p = agent.backgroundProcesses[name];
                        if (p && p.childRef) {
                            try { p.childRef.kill(); } catch(e) {}
                        }
                    });
                }
                
                // Queue the message — it will be picked up when the abort resolves
                userSuggestionQueue.push(text);
                appendMessage('system', tr('sysmsg-aborting-ops'));
                addLog(tr('log-abort-sent'), 'warning');
            } else {
                // Soft suggestion — queue it for injection into next iteration
                userSuggestionQueue.push(text);
                addLog(tr('log-soft-suggestion').replace('{text}', text.substring(0, 60)), 'info');
                sfx.apiResponse();
            }
            return;
        }

        isAgentProcessing = true;
        agent.isAborted = false;
        agent.abortController = new AbortController();
        
        sendBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        
        addLog(tr('log-new-task'), 'info');
                sfx.taskStart();
        addLog(tr('log-prompt').replace('{text}', text.substring(0, 50) + (text.length > 50 ? '...' : '')), 'info');

        updateStatus(tr('status-processing'), true);
        showTyping();
        
        if (thinkingVideo) {
            thinkingVideo.classList.add('active');
            thinkingVideo.play().catch(e=>{});
        }
        
        let isDone = false;
        let lastError = null;
        let retryCount = 0;
        const maxRetries = autoDebugCheck.checked ? 3 : 0;
        
        let currentPrompt = text;
        
        updateStatus(tr('status-scanning-project'), true);
        addLog(tr('log-sending-script-context'), 'warning');

        // ---- Save-project pre-flight ---------------------------------
        // If the project is not saved yet, pause and recommend saving so all generated
        // assets land in <projectFolder>/aisist_assets/. The user can still opt for
        // temp folders, but only after a clear consequences warning.
        try {
            const saveStatus = await agent.getProjectSaveStatus();
            if (saveStatus && !saveStatus.saved && !agent.useTempFolders) {
                hideTyping();
                const decision = await showSaveProjectRecommendation();
                if (decision === 'cancelled') {
                    isAgentProcessing = false;
                    sendBtn.classList.remove('hidden');
                    stopBtn.classList.add('hidden');
                    updateStatus(tr('status-ready'));
                    appendMessage('system', tr('save-project-cancelled-log'));
                    return;
                }
                if (decision === 'temp') {
                    agent.useTempFolders = true; // flag respected by agent.getAssetDir()
                } else if (decision === 'saved') {
                    agent.useTempFolders = false;
                }
                showTyping();
            }
        } catch (saveErr) {
            addLog('Save-status pre-flight failed (non-fatal): ' + saveErr.message, 'warning');
        }

        // Take asset snapshot to protect pre-existing user content from accidental deletion
        if (assetTracker) {
            try {
                const csi = new CSInterface();
                await assetTracker.snapshotProject(csi);
                const items = (assetTracker.snapshot.items || []).length;
                const comps = Object.keys(assetTracker.snapshot.layers || {}).length;
                if (items > 0) addLog(tr('log-protection-snapshot').replace('{items}', items).replace('{comps}', comps), 'info');
            } catch (snapErr) {
                addLog('Asset snapshot failed (non-fatal): ' + snapErr.message, 'warning');
            }
        }

        const aeCtxStart = Date.now();
        let aeContext = await agent.getDeepAEContext();
        const aeCtxTime = Date.now() - aeCtxStart;
        
        let projectIdentifier = aeContext.projectName || "Bez Tytułu";
        if (currentWorkingProject !== null && currentWorkingProject !== projectIdentifier) {
            addLog(tr('log-changed-project').replace('{from}', currentWorkingProject).replace('{to}', projectIdentifier), 'info');
            // Try to load the last session for this project
            const sessions = JSON.parse(window.diskStorage.getItem('aisist_sessions') || '{}');
            const projectSessions = Object.values(sessions)
                .filter(s => s.projectName === projectIdentifier)
                .sort((a, b) => b.id - a.id);
            if (projectSessions.length > 0) {
                const lastSession = projectSessions[0];
                currentSessionId = lastSession.id;
                agent.history = lastSession.history || [];
                chatContainer.innerHTML = lastSession.html || '';
                addLog(tr('log-loaded-project-session').replace('{title}', lastSession.title), 'success');
            }
            // If no session for this project — keep current chat, don't reset
        }
        currentWorkingProject = projectIdentifier;
        
        addLog(tr('log-ae-context-received').replace('{ms}', aeCtxTime).replace('{active}', aeContext.hasActiveComp ? '✓' : '✕'), 'success');

        let emptyStepCount = 0; // Anti-loop: consecutive empty iterations

        
                var lastStepActions = []; // Track action types for repetition detection
while (!isDone) {
            try {
                if (agent.isAborted) {
                    addLog("Proces przerwany przez uzytkownika.", "warning");
                    sfx.warning();
                    hideTyping();
                    updateStatus('Przerwano.');
                    
                    // If there was a queued message, start a new task with it
                    if (userSuggestionQueue.length > 0) {
                        const redirectText = userSuggestionQueue.join('\n');
                        userSuggestionQueue = [];
                        appendMessage('system', '⚡ Przerwano poprzednie zadanie. Rozpoczynam nowe.');
                        isAgentProcessing = false;
                        agent.isAborted = false;
                        // Trigger new task after a short delay
                        setTimeout(() => {
                            promptInput.value = redirectText;
                            handleSend();
                        }, 300);
                        return;
                    }
                    break;
                }

                if (userSuggestionQueue.length > 0) {
                    const queuedText = userSuggestionQueue.join('\n');
                    userSuggestionQueue = [];
                    currentPrompt = `[NEW USER GUIDANCE MID-ORCHESTRATION]\nThe user just sent a new message. Partially ignore your current plan if it conflicts with what the user wrote now. New message: ${queuedText}\n\n[TASK CONTINUATION]\n` + currentPrompt;
                    addLog(tr('log-injected-queue').replace('{n}', queuedText.length), 'warning');
                }

                updateStatus(retryCount > 0
                    ? tr('status-fixing-error').replace('{n}', retryCount).replace('{max}', maxRetries)
                    : tr('status-thinking'), true);
                
                let snapshotData = null;
                if (visionContextCheck.checked) {
                    // Smart Vision: only capture when there's an active comp AND visual context would help
                    const hasActiveComp = aeContext && aeContext.activeComp && aeContext.activeComp !== 'none';
                    const lastStepHadCode = retryCount > 0 || (typeof lastResponseHadCode !== 'undefined' && lastResponseHadCode);
                    const isFirstStep = stepCount === 0 || stepCount === undefined;
                    const needsVisual = hasActiveComp && (lastStepHadCode || isFirstStep || retryCount > 0);
                    
                    if (needsVisual) {
                        addLog('Pobieranie zrzutu ekranu kompozycji...', 'info');
                        const snapStart = Date.now();
                        snapshotData = await agent.getAESnapshot();
                        if (snapshotData) {
                            addLog(`Zrzut ekranu przygotowany (${Date.now() - snapStart}ms).`, 'success');
                        } else {
                            addLog('Zrzut ekranu nie powiodl sie (kompozycja moze byc pusta).', 'info');
                        }
                    }
                }
                // Track if this step had code (for next iteration's vision decision)
                var lastResponseHadCode = false;

                addLog(tr('log-llm-call').replace('{model}', agent.getActiveLLMModel() || agent.baseModel), 'warning');
                const apiStart = Date.now();
                                // Merge session-persistent attachments
                if (agent.sessionAttachments && agent.sessionAttachments.length > 0) {
                    if (!sentAttachments) sentAttachments = [];
                    // Don't duplicate — only add session attachments not already in sentAttachments
                    const existingHashes = new Set(sentAttachments.map(a => a.data ? a.data.substring(0, 50) : ''));
                    agent.sessionAttachments.forEach(sa => {
                        const hash = sa.data ? sa.data.substring(0, 50) : '';
                        if (!existingHashes.has(hash)) {
                            sentAttachments.push(sa);
                            existingHashes.add(hash);
                        }
                    });
                }
                // Create live thinking block — updates char-by-char as SSE chunks arrive
                const liveThink = createStreamingThinkingBlock();
                hideTyping();
                let response;
                try {
                    response = await agent.sendPromptToModel(
                        currentPrompt,
                        JSON.stringify(aeContext),
                        lastError,
                        snapshotData,
                        sentAttachments,
                        (delta, fullText) => liveThink.update(delta, fullText)
                    );
                    liveThink.finalize();
                } catch (apiErr) {
                    liveThink.remove();
                    throw apiErr;
                }
                const apiTime = Date.now() - apiStart;
                addLog(`LLM responded in ${apiTime}ms (streamed).`, 'success');
                sfx.apiResponse();
                
                let messageOutput = response.message || '';
                // Early completion check — ONLY break if no code and no tasks to run
                const hasCode = response.code && ((Array.isArray(response.code) && response.code.length > 0) || (typeof response.code === 'string' && response.code.trim().length > 0));
                const hasParallel = response.parallel_tasks && Object.keys(response.parallel_tasks).length > 0;
                const hasAttach = response.attach_files && response.attach_files.length > 0;
                
                if (response.is_task_complete === true && !hasCode && !hasParallel && !hasAttach) {
                    sfx.taskComplete();
                    if (messageOutput) {
                        appendMessage('assistant', messageOutput, response.thought, response.current_plan);
                    } else {
                        appendMessage('assistant', tr('amsg-task-done'), response.thought, response.current_plan);
                    }
                    isDone = true;
                    addLog('Zadanie zakonczone (is_task_complete: true).', 'success');
                    updateStatus('Zadanie zakonczone.');
                    saveSession();
                    break;
                }


                if (typeof stepCount === 'undefined') var stepCount = 0;
                stepCount++;
                lastResponseHadCode = !!(response.code || (response.render_preview));

                
                                // Handle attach_files: agent autonomously attaches project files to its context
                if (response.attach_files && Array.isArray(response.attach_files) && response.attach_files.length > 0) {
                    const fsNode = require('fs');
                    const pathNode = require('path');
                    const agentAttachments = [];
                    
                    for (const fileReq of response.attach_files) {
                        try {
                            let filePath = fileReq.path || fileReq;
                            
                            // Resolve project-relative paths via AE project folder
                            if (!pathNode.isAbsolute(filePath) && aeContext && aeContext.projectPath) {
                                filePath = pathNode.join(pathNode.dirname(aeContext.projectPath), filePath);
                            }
                            
                            if (!fsNode.existsSync(filePath)) {
                                addLog('attach_files: plik nie istnieje: ' + filePath, 'warning');
                                continue;
                            }
                            
                            const ext = pathNode.extname(filePath).toLowerCase();
                            const stats = fsNode.statSync(filePath);
                            
                            // Size limit: 10MB for images/audio, 5MB for video frames
                            if (stats.size > 10 * 1024 * 1024) {
                                addLog('attach_files: plik za duzy (' + Math.round(stats.size/1024/1024) + 'MB): ' + filePath, 'warning');
                                continue;
                            }
                            
                            const mimeMap = {
                                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                                '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
                                '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
                                '.flac': 'audio/flac', '.aac': 'audio/aac',
                                '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
                                '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv',
                                '.srt': 'text/plain', '.jsx': 'text/plain', '.py': 'text/plain',
                                '.md': 'text/plain', '.xml': 'text/xml', '.html': 'text/html',
                                '.pdf': 'application/pdf'
                            };
                            
                            const mimeType = fileReq.mime || mimeMap[ext] || 'application/octet-stream';
                            
                            if (mimeType.startsWith('text/') || mimeType === 'application/json') {
                                // Text files — inject as text part
                                const content = fsNode.readFileSync(filePath, 'utf8');
                                const label = fileReq.label || pathNode.basename(filePath);
                                lastError = (lastError || '') + '\n[PLIK: ' + label + ']\n' + content.substring(0, 8000) + (content.length > 8000 ? '\n...(obciety, ' + content.length + ' znakow)' : '') + '\n[/PLIK]';
                                addLog('attach_files: tekst "' + label + '" (' + content.length + ' zn.)', 'info');
                            } else {
                                // Binary files — inject as inlineData
                                const base64 = fsNode.readFileSync(filePath, 'base64');
                                agentAttachments.push({
                                    mimeType: mimeType,
                                    data: base64
                                });
                                addLog('attach_files: ' + mimeType + ' (' + Math.round(stats.size/1024) + ' KB): ' + pathNode.basename(filePath), 'info');
                            }
                        } catch(e) {
                            addLog('attach_files error: ' + e.message, 'warning');
                        }
                    }
                    
                    // Merge with existing attachments for next iteration
                    if (agentAttachments.length > 0) {
                        if (!sentAttachments) sentAttachments = [];
                        sentAttachments = sentAttachments.concat(agentAttachments);
                        addLog('Agent zalaczyl ' + agentAttachments.length + ' plikow binarnych do kontekstu.', 'success');
                        // Persist attachments for the entire session - BOUNDED to prevent memory leak
                        agent.sessionAttachments = agent.sessionAttachments.concat(agentAttachments);
                        const maxAtt = agent.MAX_SESSION_ATTACHMENTS || 6;
                        if (agent.sessionAttachments.length > maxAtt) {
                            const dropped = agent.sessionAttachments.length - maxAtt;
                            agent.sessionAttachments = agent.sessionAttachments.slice(-maxAtt);
                            addLog('Session attachments: ograniczono do ' + maxAtt + ' (odrzucono ' + dropped + ' starszych binarnych).', 'info');
                        }

                        sfx.assetReady();
                    }
                }
                
if (response.update_memory && Array.isArray(response.update_memory)) {
                    response.update_memory.forEach(op => {
                        const ts = new Date().toISOString();
                        if (op.action === 'add' && op.content) {
                            agent.longTermMemory.push({
                                id: Date.now() + Math.floor(Math.random()*100),
                                type: op.type || 'system',
                                category: op.category || 'general',
                                content: op.content,
                                timestamp: ts,
                                version: 1
                            });
                            addLog('LTM +add [' + (op.category || 'general') + ']: ' + op.content.substring(0, 60), 'info');
                        } else if (op.action === 'update' && op.id && op.content) {
                            // Update existing entry by ID
                            const entry = agent.longTermMemory.find(m => m.id === op.id);
                            if (entry) {
                                entry.content = op.content;
                                entry.timestamp = ts;
                                entry.version = (entry.version || 1) + 1;
                                if (op.category) entry.category = op.category;
                                addLog('LTM ~update [' + entry.category + '] ID:' + op.id, 'info');
                            }
                        } else if (op.action === 'replace_category' && op.category && op.content) {
                            // Remove ALL entries in this category, add new one (supersede)
                            const removed = agent.longTermMemory.filter(m => m.category === op.category);
                            agent.longTermMemory = agent.longTermMemory.filter(m => m.category !== op.category);
                            agent.longTermMemory.push({
                                id: Date.now() + Math.floor(Math.random()*100),
                                type: op.type || 'system',
                                category: op.category,
                                content: op.content,
                                timestamp: ts,
                                version: 1
                            });
                            addLog('LTM ⟲replace [' + op.category + '] (' + removed.length + ' old → 1 new)', 'info');
                        } else if (op.action === 'delete' && op.id) {
                            agent.longTermMemory = agent.longTermMemory.filter(m => m.id !== op.id);
                            addLog('LTM -delete ID:' + op.id, 'info');
                        } else if (op.action === 'delete_category' && op.category) {
                            const count = agent.longTermMemory.filter(m => m.category === op.category).length;
                            agent.longTermMemory = agent.longTermMemory.filter(m => m.category !== op.category);
                            addLog('LTM -delete_category [' + op.category + '] (' + count + ' entries)', 'info');
                        }
                    });
                    window.diskStorage.setItem('aisist_memory_arr', JSON.stringify(agent.longTermMemory));
                    if (typeof renderMemoryList === 'function') renderMemoryList();
                    addLog(tr('log-ltm-updated').replace('{n}', response.update_memory.length), 'info');
                }

                // Handle save_skill from agent
                if (response.save_skill && response.save_skill.name && response.save_skill.content) {
                    const saved = agent.saveSkill(response.save_skill.name, response.save_skill.content);
                    if (saved) {
                        addLog(tr('log-skill-saved').replace('{name}', response.save_skill.name), 'success');
                        appendMessage('assistant', tr('sysmsg-skill-saved-toast').replace('{name}', response.save_skill.name));
                    }
                }

                // Handle load_skill from agent
                if (response.load_skill) {
                    const skill = agent.skills.find(s => s.name === response.load_skill);
                    if (skill) {
                        addLog(tr('log-skill-loaded').replace('{name}', skill.name), 'info');
                        let skillContext = '[SKILL LOADED: ' + skill.name + ']\n' + skill.content + '\n\n';
                        // For Python skills, add actionable usage instructions
                        if (skill.type === 'python' && skill.env) {
                            const reg = agent.loadSkillsRegistry();
                            const regSkill = reg.skills.find(s => s.name === skill.name);
                            if (regSkill && regSkill.scriptContent) {
                                skillContext += '[READY PYTHON SCRIPT]\n' + regSkill.scriptContent + '\n\n';
                            }
                            skillContext += '[HOW TO USE THIS SKILL]\nIn parallel_tasks.python add: {"env":"' + skill.env + '","packages":' + JSON.stringify(skill.packages || []) + ',"script":"<your script using this env>"}\n';
                            skillContext += 'Env "' + skill.env + '" already has packages installed — you do NOT need to reinstall them.\n';
                            skillContext += 'IMPORTANT: use FULL paths to files from the asset manifest!\n';
                        }
                        skillContext += '\n[NOW EXECUTE THE TASK: generate parallel_tasks.python with the skill above OR write ExtendScript. DO NOT LEAVE AN EMPTY STEP!]';
                        lastError = (lastError || '') + '\n' + skillContext;
                    } else {
                        addLog(`Skill not found: ${response.load_skill}`, 'warning');
                        lastError = (lastError || '') + '\nSkill "' + response.load_skill + '" not found. Use parallel_tasks.python to recreate it from scratch.';
                    }
                }

                hideTyping();

                if (messageOutput || response.current_plan) {
                    appendMessage('assistant', messageOutput || tr('amsg-doing-task'), response.thought, response.current_plan);
                } else if (response.thought) {
                    appendMessage('assistant', tr('amsg-doing-task'), response.thought);
                }

                // --- PARALLEL TASKS (must run BEFORE questions_for_user!) ---
                let parallelPromises = [];
                let pipelineStepIds = {}; // map of promise index -> step id for live updates

                // Clear stale image paths at the start of each step
                    // Pass attached reference images to image generator
                    agent._pendingReferenceImages = (sentAttachments && sentAttachments.length > 0) ? sentAttachments : null;

                if (response.parallel_tasks && response.parallel_tasks.images) {
                    agent.lastGeneratedImagePaths = [];
                }

                // Start pipeline UI if there's any parallel work this step
                const hasAnyParallelKind = response.parallel_tasks && (
                    (response.parallel_tasks.images && response.parallel_tasks.images.length) ||
                    (response.parallel_tasks.tts && response.parallel_tasks.tts.length) ||
                    (response.parallel_tasks.video_grok && response.parallel_tasks.video_grok.length) ||
                    (response.parallel_tasks.music && response.parallel_tasks.music.length) ||
                    (response.parallel_tasks.sfx && response.parallel_tasks.sfx.length) ||
                    (response.parallel_tasks.svg && response.parallel_tasks.svg.length) ||
                    (response.parallel_tasks.python && response.parallel_tasks.python.length) ||
                    (response.parallel_tasks.edit_images && response.parallel_tasks.edit_images.length) ||
                    (response.parallel_tasks.transcribe_audio && response.parallel_tasks.transcribe_audio.length) ||
                    (response.parallel_tasks.whisperx && response.parallel_tasks.whisperx.length)
                );
                if (hasAnyParallelKind) {
                    const subtitle = (response.message && response.message.substring(0, 60)) || ('Step ' + (stepCount || 1));
                    startPipeline('Generowanie assetów', subtitle, '✨');
                }

                if (response.parallel_tasks) {
                    let imagePromises = [];
                    if (response.parallel_tasks.images && response.parallel_tasks.images.length > 0) {
                        // Pre-allocate image path slots so indexes stay correct regardless of completion order
                        agent.lastGeneratedImagePaths = new Array(response.parallel_tasks.images.length).fill(null);
                        response.parallel_tasks.images.forEach((imgPrompt, imgIdx) => {
                            const stepId = pipelineAdd({ kind: 'image', label: 'Obraz #' + (imgIdx + 1) + ': ' + (imgPrompt || '').substring(0, 50), status: 'running', parallelGroup: 'images' });
                            const p = agent.generateImageAndImport(imgPrompt, (msg) => {
                                updateStatus(msg, true);
                                addLog(msg, 'info');
                                pipelineUpdate(stepId, { message: msg });
                            }, imgIdx).then(res => {
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'Obraz', res, prompt: imgPrompt, index: imgIdx };
                            });
                            imagePromises.push(p);
                            parallelPromises.push(p);
                        });
                    }
                    let ttsPromises = [];
                    if (response.parallel_tasks.tts && response.parallel_tasks.tts.length > 0) {
                        response.parallel_tasks.tts.forEach((ttsPrompt, ttsIdx) => {
                            const stepId = pipelineAdd({ kind: 'tts', label: 'Lektor #' + (ttsIdx + 1) + ': ' + (ttsPrompt || '').substring(0, 50), status: 'running', parallelGroup: 'tts' });
                            const p = agent.generateSpeechAndImport(ttsPrompt, (msg) => {
                                updateStatus(msg, true);
                                addLog(msg, 'info');
                                pipelineUpdate(stepId, { message: msg });
                            }).then(res => {
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || ('Gotowe (' + (res.durationSec || '?') + 's)') });
                                return { type: 'Lektor', res, prompt: ttsPrompt };
                            });
                            ttsPromises.push(p);
                            parallelPromises.push(p);
                        });
                    }
                    if (response.parallel_tasks.video_grok && response.parallel_tasks.video_grok.length > 0) {
                        response.parallel_tasks.video_grok.forEach((grokItem, vIdx) => {
                            const stepId = pipelineAdd({ kind: 'video', label: 'Wideo Grok #' + (vIdx + 1) + ': ' + (grokItem.prompt || '').substring(0, 40), status: 'pending', parallelGroup: 'video' });
                            const videoTask = async () => {
                                if (!grokItem.source) {
                                    addLog('UWAGA: video_grok bez source! Grok nie uzyje klatki z Gemini.', 'warning');
                                }
                                if (grokItem.source && grokItem.source.includes('last_image') && imagePromises.length > 0) {
                                    pipelineUpdate(stepId, { status: 'pending', message: 'Czeka na obrazy...' });
                                    addLog('Wideo Grok oczekuje na wygenerowanie powiazanych obrazow...', 'info');
                                    await Promise.all(imagePromises);
                                }
                                pipelineUpdate(stepId, { status: 'running' });
                                const res = await agent.generateVideoAndImport(grokItem, (msg) => {
                                    updateStatus(msg, true);
                                    addLog(msg, 'info');
                                    pipelineUpdate(stepId, { message: msg });
                                });
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'Wideo Grok', res, prompt: grokItem.prompt };
                            };
                            parallelPromises.push(videoTask());
                        });
                    }
                    if (response.parallel_tasks.music && response.parallel_tasks.music.length > 0) {
                        response.parallel_tasks.music.forEach((musicPrompt, mIdx) => {
                            const stepId = pipelineAdd({ kind: 'music', label: 'Muzyka #' + (mIdx + 1) + ': ' + (musicPrompt || '').substring(0, 40), status: 'pending', parallelGroup: 'music' });
                            const musicTask = async () => {
                                if (ttsPromises.length > 0) {
                                    pipelineUpdate(stepId, { message: 'Czeka na TTS...' });
                                    addLog('Muzyka oczekuje na zakonczenie TTS (pomiar dlugosci)...', 'info');
                                    await Promise.all(ttsPromises);
                                }
                                let finalMusicPrompt = musicPrompt;
                                if (agent.lastTtsDurationSec && agent.lastTtsDurationSec > 0) {
                                    const mins = Math.floor(agent.lastTtsDurationSec / 60);
                                    const secs = agent.lastTtsDurationSec % 60;
                                    const endTimestamp = mins + ':' + (secs < 10 ? '0' : '') + secs;
                                    finalMusicPrompt = '[0:00 - ' + endTimestamp + '] ' + musicPrompt;
                                    addLog('Muzyka: wymuszono dlugosc ' + agent.lastTtsDurationSec + 's (dopasowanie do lektora).', 'success');
                                }
                                pipelineUpdate(stepId, { status: 'running' });
                                const res = await agent.generateMusicAndImport(finalMusicPrompt, (msg) => {
                                    updateStatus(msg, true);
                                    addLog(msg, 'info');
                                    pipelineUpdate(stepId, { message: msg });
                                });
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'Muzyka', res, prompt: finalMusicPrompt };
                            };
                            parallelPromises.push(musicTask());
                        });
                    }
                    // --- SFX (ElevenLabs Text-to-Sound-Effects) ---
                    if (response.parallel_tasks.sfx && response.parallel_tasks.sfx.length > 0) {
                        response.parallel_tasks.sfx.forEach((sfxItem, sfxIdx) => {
                            const item = (typeof sfxItem === 'string') ? { prompt: sfxItem } : sfxItem;
                            const label = 'SFX #' + (sfxIdx + 1) + ': ' + (item.prompt || '').substring(0, 40)
                                        + (item.duration_seconds ? ' (' + item.duration_seconds + 's)' : '')
                                        + (item.loop ? ' [loop]' : '');
                            const stepId = pipelineAdd({ kind: 'music', icon: '🔊', label: label, status: 'running', parallelGroup: 'sfx' });
                            const p = agent.generateSFXAndImport(item, (msg) => {
                                updateStatus(msg, true);
                                addLog(msg, 'info');
                                pipelineUpdate(stepId, { message: msg });
                            }).then(res => {
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'SFX', res, prompt: item.prompt };
                            });
                            parallelPromises.push(p);
                        });
                    }
                    if (response.parallel_tasks.transcribe_audio && response.parallel_tasks.transcribe_audio.length > 0) {
                        response.parallel_tasks.transcribe_audio.forEach((item, idx) => {
                            const stepId = pipelineAdd({ kind: 'stt', label: 'Transkrypcja #' + (idx + 1), status: 'pending', parallelGroup: 'stt' });
                            const transcribeTask = async () => {
                                if (item.source === 'last_audio' && ttsPromises.length > 0) {
                                    pipelineUpdate(stepId, { message: 'Czeka na TTS...' });
                                    addLog('Napisy oczekuja na wygenerowanie pliku TTS...', 'info');
                                    await Promise.all(ttsPromises);
                                }
                                pipelineUpdate(stepId, { status: 'running' });
                                const res = await agent.transcribeAudio(item.source, (msg) => {
                                    updateStatus(msg, true);
                                    addLog(msg, 'info');
                                    pipelineUpdate(stepId, { message: msg });
                                });
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'Napisy ElevenLabs', res, prompt: 'Transkrypcja audio' };
                            };
                            parallelPromises.push(transcribeTask());
                        });
                    }

                    // --- SVG Generator ---
                    if (response.parallel_tasks.svg && response.parallel_tasks.svg.length > 0) {
                        response.parallel_tasks.svg.forEach((svgPrompt, sIdx) => {
                            const stepId = pipelineAdd({ kind: 'svg', label: 'SVG #' + (sIdx + 1) + ': ' + (svgPrompt || '').substring(0, 40), status: 'running', parallelGroup: 'svg' });
                            const p = agent.generateSVGAndImport(svgPrompt, (msg) => {
                                updateStatus(msg, true);
                                addLog(msg, 'info');
                                pipelineUpdate(stepId, { message: msg });
                            }).then(res => {
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'SVG', res, prompt: svgPrompt };
                            });
                            parallelPromises.push(p);
                        });
                    }
                    // --- Image Edit / Inpainting ---
                    if (response.parallel_tasks.edit_images && response.parallel_tasks.edit_images.length > 0) {
                        response.parallel_tasks.edit_images.forEach((editItem) => {
                            const editTask = async () => {
                                if (editItem.source && editItem.source.includes('last_image') && imagePromises.length > 0) {
                                    addLog('Image Edit oczekuje na generowanie obrazow...', 'info');
                                    await Promise.all(imagePromises);
                                }
                                const res = await agent.editImageAndImport(editItem.prompt, editItem.source, (msg) => {
                                    updateStatus(msg, true);
                                    addLog(msg, 'info');
                                });
                                return { type: 'Image Edit', res, prompt: editItem.prompt };
                            };
                            parallelPromises.push(editTask());
                        });
                    }
                
                    // --- WhisperX Word-Level Transcription ---
                    if (response.parallel_tasks.whisperx && response.parallel_tasks.whisperx.length > 0) {
                        response.parallel_tasks.whisperx.forEach((wxItem, wxIdx) => {
                            const stepId = pipelineAdd({ kind: 'stt', label: 'WhisperX #' + (wxIdx + 1), status: 'pending', parallelGroup: 'whisperx' });
                            const wxTask = async () => {
                                if (wxItem.source === 'last_audio' && ttsPromises.length > 0) {
                                    pipelineUpdate(stepId, { message: 'Czeka na TTS...' });
                                    addLog('WhisperX oczekuje na TTS...', 'info');
                                    await Promise.all(ttsPromises);
                                }
                                pipelineUpdate(stepId, { status: 'running' });
                                const res = await agent.transcribeWhisperX(wxItem.source, (msg) => {
                                    updateStatus(msg, true);
                                    addLog(msg, 'info');
                                    pipelineUpdate(stepId, { message: msg });
                                });
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || 'Gotowe' });
                                return { type: 'WhisperX', res, prompt: 'Transkrypcja word-level' };
                            };
                            parallelPromises.push(wxTask());
                        });
                    }
                    // --- Python Environment ---
                    if (response.parallel_tasks.python && response.parallel_tasks.python.length > 0) {
                        response.parallel_tasks.python.forEach((pyTask, pyIdx) => {
                            const pyLabel = 'Python: ' + (pyTask.env || 'default') + (pyTask.background ? ' (background)' : '');
                            const stepId = pipelineAdd({ kind: 'python', label: pyLabel, status: 'running', parallelGroup: 'python' });
                            const pyTaskPromise = agent.runPythonTask(pyTask, (msg) => {
                                updateStatus(msg, true);
                                addLog(msg, 'info');
                                pipelineUpdate(stepId, { message: msg });
                            }).then(res => {
                                pipelineUpdate(stepId, { status: res.error ? 'failed' : 'done', message: res.error || ('env: ' + (pyTask.env || 'default')) });
                                return res;
                            }).then(res => {
                                if (res.success && res.results) {
                                    const output = res.results.map(r => {
                                        let line = r.step + ': ';
                                        if (r.stdout) line += r.stdout.substring(0, 500);
                                        else if (r.output) line += r.output.substring(0, 500);
                                        else line += r.success !== false ? 'ok' : 'FAIL';
                                        if (r.stderr) line += ' [stderr: ' + r.stderr.substring(0, 200) + ']';
                                        return line;
                                    }).join('\n');
                                    addLog('Python [' + (pyTask.env || 'default') + ']: ' + output.substring(0, 200), 'success');
                                    // Auto-save as skill if requested
                                    if (pyTask.save_as_skill && res.success) {
                                        var saved = agent.savePythonSkill({
                                        name: pyTask.save_as_skill.name || pyTask.env,
                                        description: pyTask.save_as_skill.description || '',
                                        env: pyTask.env || 'default',
                                        packages: pyTask.packages || [],
                                        scriptPath: pyTask.save_as_skill.scriptPath || null,
                                        scriptContent: pyTask.script || null
                                    })
                                        addLog(tr('log-skill-saved-as').replace('{name}', saved.name).replace('{desc}', saved.description), 'success');
                                    }

                                    return { type: 'Python', res: { success: true, message: output, filePath: res.envPath }, prompt: 'env:' + (pyTask.env || 'default') };
                                }
                                if (res.error) {
                                    addLog('Python error: ' + res.error, 'error');
                                }
                                return { type: 'Python', res, prompt: 'env:' + (pyTask.env || 'default') };
                            });
                            parallelPromises.push(pyTaskPromise);
                        });
                    }
}

                if (parallelPromises.length > 0) {
                    addLog('Rozpoczeto generowanie ' + parallelPromises.length + ' zasobow ROWNOLEGLE...', 'warning');
                    // Removed the noisy "Rozpoczynam rownolegle tworzenie asetow AI" text-msg —
                    // the Pipeline card now visualises everything in real-time.

                    const pStart = Date.now();
                    const results = await Promise.all(parallelPromises);
                    const pTime = Date.now() - pStart;

                    let errs = [];
                    let transcripts = [];
                    results.forEach(r => {
                        if (r.res.error) errs.push('[' + r.type + '] ' + r.res.error);
                        if (r.type === 'Napisy ElevenLabs' && r.res.success) transcripts.push(r.res.message);
                    });

                    // Finalize the pipeline card
                    pipelineFinish(errs.length === 0
                        ? '✓ Wszystkie ' + parallelPromises.length + ' zadań ukończone w ' + (pTime / 1000).toFixed(1) + 's'
                        : '⚠ ' + (results.length - errs.length) + '/' + results.length + ' ukończonych · ' + errs.length + ' błędów · ' + (pTime / 1000).toFixed(1) + 's');
                    
                    if (transcripts.length > 0) {
                        addLog('Przechwycono pomyslne transkrypcje: ' + transcripts.length, 'success');
                        lastError = 'PARALLEL TASK RESULTS - ELEVENLABS TRANSCRIPT:\n' + transcripts.join('\n\n') + '\n\n-> Use this JSON to build animated word-level captions in After Effects.';
                    }

                    if (errs.length > 0) {
                        addLog('Blad w zadaniach rownoleglych: ' + errs.join(', '), 'error');
                        appendMessage('assistant', 'Pewne procesy rownolegle napotkaly bledy: ' + errs.join(', '));
                        lastError = (lastError ? lastError + "\n\n" : "") + 'Parallel tasks returned errors: ' + errs.join(', ');
                    } else {
                        addLog('Zakonczono generowanie rownolegle pomyslnie w ' + pTime + 'ms.', 'success');
                    // Track action type for repetition detection
                    var actionType = '';
                    if (response.parallel_tasks.images) actionType = 'image_gen';
                    else if (response.parallel_tasks.python) actionType = 'python';
                    else if (response.parallel_tasks.video_grok) actionType = 'video';
                    else actionType = 'other';
                    lastStepActions.push(actionType);
                    
                    // Repetition detection: 4+ consecutive identical actions = force stop
                    if (lastStepActions.length >= 4) {
                        const last4 = lastStepActions.slice(-4);
                        if (last4.every(a => a === last4[0]) && last4[0] === 'image_gen') {
                            addLog('Repetition detector: 4 consecutive image generations — forcing completion to prevent infinite loop.', 'warning');
                            sfx.taskComplete();
                            isDone = true;
                            appendMessage('assistant', tr('amsg-repetition-stop'));
                            updateStatus('Zadanie zakonczone (repetition detection).');
                        }
                    }

                    sfx.assetReady();
                    emptyStepCount = 0; // Reset anti-loop counter
                        appendMessage('assistant', 'Wszystkie zasoby z pakietu dotarly pomyslnie.');
                        if (!response.code) lastError = null;
                    }

                    // Build asset manifest for agent context
                    let assetManifest = [];
                    results.forEach((r, idx) => {
                        if (r.res && r.res.success) {
                            const entry = {
                                id: idx + 1,
                                type: r.type,
                                file: r.res.filePath ? r.res.filePath.replace(/\\/g, '/').split('/').pop() : 'unknown',
                                path: r.res.filePath || '',
                                prompt: (r.prompt || '').substring(0, 80),
                                duration: r.res.durationSec || null
                            };
                            // Mark edited images as superseding originals
                            if (r.type === 'Image Edit') {
                                entry.supersedes = 'Oryginalne zdjecie (uzyj TEJ wersji zamiast oryginalu!)';
                            }
                            assetManifest.push(entry);
                        }
                    });
                    
                    if (assetManifest.length > 0) {
                        const manifestStr = '\n--- GENERATED ASSETS MANIFEST ---\n' +
                            assetManifest.map(a => {
                                let line = '#' + a.id + ' [' + a.type + '] ' + a.file;
                                if (a.prompt) line += ' | Prompt: "' + a.prompt + '"';
                                if (a.duration) line += ' | Dlugosc: ' + a.duration + 's';
                                if (a.supersedes) line += ' | ' + a.supersedes;
                                return line;
                            }).join('\n') +
                            '\n--- END OF MANIFEST ---';
                        lastError = (lastError || '') + manifestStr;
                        addLog('Manifest assetow: ' + assetManifest.length + ' plikow opisanych dla agenta.', 'success');
                    }

                                        // Add WhisperX results to agent context
                    const wxResults = results.filter(r => r.type === 'WhisperX');
                    if (wxResults.length > 0) {
                        wxResults.forEach(wx => {
                            if (wx.res.success && wx.res.words) {
                                let wxCtx = '\n--- WHISPERX TRANSCRIPTION (WORD-LEVEL) ---\n';
                                wxCtx += 'Jezyk: ' + wx.res.language + ' | Slow: ' + wx.res.wordCount + '\n';
                                wxCtx += 'Pelny tekst: ' + wx.res.text + '\n\n';
                                wxCtx += 'Slowa z timestampami (JSON):\n';
                                wxCtx += JSON.stringify(wx.res.words.slice(0, 200), null, 1);
                                if (wx.res.words.length > 200) wxCtx += '\n... (' + (wx.res.words.length - 200) + ' wiecej slow)';
                                wxCtx += '\n--- END OF WHISPERX ---';
                                wxCtx += '\n-> Uzyj tych danych do stworzenia animowanych napisow w AE (Source Text keyframes + marker per word).';
                                lastError = (lastError || '') + wxCtx;
                                addLog('WhisperX: ' + wx.res.wordCount + ' slow z timestampami dodano do kontekstu.', 'success');
                            } else if (wx.res.error) {
                                addLog('WhisperX error: ' + wx.res.error, 'error');
                            }
                        });
                    }

                    // Add Python task outputs to agent context
                    const pythonResults = results.filter(r => r.type === 'Python');
                    if (pythonResults.length > 0) {
                        let pyCtx = '\n--- PYTHON RESULTS ---\n';
                        pythonResults.forEach(pr => {
                            pyCtx += '[' + pr.prompt + '] ' + (pr.res.message || pr.res.error || 'brak wynikow') + '\n';
                        });
                        pyCtx += '--- END OF PYTHON RESULTS ---';
                        lastError = (lastError || '') + pyCtx;
                        addLog('Python wyniki dodane do kontekstu agenta.', 'success');
                    }

                    // Display generated assets as draggable cards in chat (image/audio/video/SVG).
                    // Users can drag any card into Project / Timeline / Comp panels in After Effects.
                    const assetCards = [];

                    // Images & SVG edits
                    results.filter(r => (r.type === 'Obraz' || r.type === 'Image Edit') && r.res.success && r.res.filePath)
                        .forEach((r, idx) => assetCards.push({
                            type: 'image', filePath: r.res.filePath, prompt: r.prompt || '', index: idx
                        }));
                    results.filter(r => r.type === 'SVG' && r.res.success && r.res.filePath)
                        .forEach((r) => assetCards.push({
                            type: 'svg', filePath: r.res.filePath, prompt: r.prompt || ''
                        }));

                    // Audio: TTS / music / SFX (each has its own kind hint for icon selection)
                    results.filter(r => r.type === 'Lektor' && r.res.success && r.res.filePath)
                        .forEach((r) => assetCards.push({
                            type: 'audio', kind: 'tts', filePath: r.res.filePath,
                            duration: r.res.durationSec, prompt: r.prompt || ''
                        }));
                    results.filter(r => r.type === 'Muzyka' && r.res.success && r.res.filePath)
                        .forEach((r) => assetCards.push({
                            type: 'audio', kind: 'music', filePath: r.res.filePath,
                            duration: r.res.durationSec, prompt: r.prompt || ''
                        }));
                    results.filter(r => r.type === 'SFX' && r.res.success && r.res.filePath)
                        .forEach((r) => assetCards.push({
                            type: 'audio', kind: 'sfx', filePath: r.res.filePath,
                            duration: r.res.durationSec, prompt: r.prompt || ''
                        }));

                    // Video (Grok)
                    results.filter(r => r.type === 'Wideo Grok' && r.res.success && r.res.filePath)
                        .forEach((r, idx) => assetCards.push({
                            type: 'video', filePath: r.res.filePath,
                            duration: r.res.durationSec, prompt: r.prompt || '', index: idx
                        }));

                    if (assetCards.length > 0) {
                        const headerText = tr('asset-grid-header').replace('{n}', assetCards.length);
                        appendAssetGrid(assetCards, headerText);
                    }
                }

                // --- Render Preview ---
                if (response.render_preview && agent.isFeatureEnabled('renderPreview')) {
                    addLog('Przechwytywanie klatek podgladu animacji...', 'info');
                    try {
                        const preview = await agent.captureRenderPreview(response.render_preview === true ? 4 : parseInt(response.render_preview, 10) || 4);
                        if (preview.success && preview.frames.length > 0) {
                            addLog('Przechwycono ' + preview.frames.length + ' klatek podgladu.', 'success');
                            // Store frames for injection into next API call as vision context
                            sentAttachments = preview.frames
                                .filter(f => f.data && f.data.length > 100) // Skip corrupted/empty frames
                                .map(f => ({ mimeType: f.mimeType, data: f.data }));
                            if (sentAttachments.length === 0) {
                                addLog('Render preview: wszystkie klatki puste/uszkodzone, pomijam.', 'warning');
                                sentAttachments = null;
                            }
                            if (!lastError) lastError = '';
                            lastError += '\n[RENDER PREVIEW: You received ' + preview.frames.length + ' animation frames from different moments of the timeline. Evaluate motion, timing, and visual quality.]';
                        } else {
                            addLog('Render preview: ' + (preview.error || 'brak klatek'), 'warning');
                        }
                    } catch(rpErr) { addLog('Render preview error: ' + rpErr, 'warning'); }
                }

                // --- QUESTIONS (after parallel_tasks so images are generated first!) ---
                if (response.questions_for_user && Array.isArray(response.questions_for_user) && response.questions_for_user.length > 0) {
                    addLog('Agent zadal ' + response.questions_for_user.length + ' pytan, wstrzymanie orkiestracji...', 'warning');
                    
                    const qAnswers = await presentQuestionsToUser(response.questions_for_user);
                    
                    currentPrompt = '[ANSWERS TO YOUR QUESTIONS (FORM)]\n' + qAnswers + '\n\nContinue executing the task. If I accepted your suggestions, apply them in the code.';
                    appendMessage('user', "Zatwierdzono formularz odpowiedzi (Widoczne dla agenta).");
                    
                    sentAttachments = [];
                    continue; 
                }

                let extCode = response.code;
                if (Array.isArray(extCode)) extCode = extCode.join('\n');

                if (extCode && typeof extCode === 'string' && extCode.trim().length > 0) {
                    // Pre-flight Code Validator
                    const validation = agent.validateCode(extCode);
                    if (validation.warnings.length > 0) {
                        validation.warnings.forEach(w => addLog('Validator: ' + w, 'warning'));
                    }
                    if (!validation.valid) {
                        const errMsg = validation.errors.join('; ');
                        addLog('Validator ZABLOKOVAL kod: ' + errMsg, 'error');
                        lastError = 'PRE-FLIGHT VALIDATOR: ' + errMsg;
                        appendMessage('assistant', 'Kod zablokowany przez walidator: ' + errMsg + '. Naprawiam...');
                        retryCount++;
                        if (retryCount >= maxRetries) { isDone = true; updateStatus('Przerwano (walidacja).'); break; }
                        currentPrompt = 'Your code was BLOCKED by the pre-flight validator BEFORE reaching AE. Errors: ' + errMsg;
                        showTyping();
                        continue;
                    }

                    // ---- Destructive-op permission gate ----
                    // If validator flagged remove() / file deletion, ask user before executing.
                    if (validation.destructiveOps && validation.destructiveOps.length > 0 && permManager) {
                        const ops = validation.destructiveOps;
                        addLog(tr('log-detected-destructive').replace('{n}', ops.length), 'warning');
                        let allApproved = true;
                        for (const op of ops) {
                            const target = op.target || '(brak nazwy)';
                            // Auto-allow if target is a known transient (aisist_*)
                            const classification = assetTracker ? assetTracker.classify(target.replace(/['"]/g, '')) : 'unknown';
                            if (classification === 'transient') {
                                addLog(tr('log-skip-transient-file').replace('{target}', target), 'info');
                                continue;
                            }
                            const reasonText = response.message || response.thought || '(brak uzasadnienia w odpowiedzi agenta)';
                            const decision = await requestPermission(op.op, target, reasonText.substring(0, 300));
                            if (decision === 'deny') {
                                allApproved = false;
                                addLog(tr('log-user-denied-op').replace('{op}', op.op).replace('{target}', target), 'warning');
                                break;
                            }
                        }
                        if (!allApproved) {
                            lastError = '[USER DENIED DESTRUCTIVE OP] The user refused the deletion. ABSOLUTELY do not delete this element. Propose an alternative (e.g. duplicate instead of delete, hide instead of remove).';
                            appendMessage('assistant', tr('sysmsg-delete-rejected'));
                            retryCount++;
                            if (retryCount >= maxRetries) { isDone = true; updateStatus('Przerwano (user deny).'); break; }
                            currentPrompt = 'The user REFUSED the destructive operation from the previous code. Do not delete this element. Propose a solution that PRESERVES the original (duplicate, hide, copy).';
                            showTyping();
                            continue;
                        }
                    }

                    updateStatus('Wykonuje skrypt AE...', true);
                    addLog('Wywolywanie kodu ExtendScript w After Effects...', 'warning');
                    
                    // --- Checkpoint: capture state BEFORE execution ---
                    let checkpoint = null;
                    try {
                        checkpoint = await new Promise((resolve) => {
                            const csi = new CSInterface();
                            csi.evalScript('getProjectCheckpoint()', (r) => resolve(r));
                        });
                    } catch(cpErr) { addLog('Checkpoint capture failed: ' + cpErr, 'warning'); }

                    
                    const codeStart = Date.now();
                    const aeResult = await agent.runExtendScript(extCode);
                    const codeTime = Date.now() - codeStart;
                    
                    if (aeResult.success) {
                        addLog(`Skrypt wykonany z sukcesem w ${codeTime}ms.`, 'success');
                    sfx.codeRun();
                        if (aeResult.result && aeResult.result !== "Done" && aeResult.result !== "undefined") {
                             appendMessage('assistant', tr('amsg-execution-result').replace('{res}', aeResult.result));
                             addLog(`Wynik: ${aeResult.result}`, 'info');
                        }
                        // Surface UndoGroup warning to agent so it learns to drop manual begin/end calls
                        if (aeResult.warning) {
                            addLog('UndoGroup warning: ' + aeResult.warning, 'warning');
                            lastError = (lastError ? lastError + '\n' : '') + '[UNDO GROUP WARNING - przeczytaj reguly UndoGroup w prompcie systemowym!] ' + aeResult.warning;
                        } else {
                            lastError = null;
                        }
                        retryCount = 0;
                        emptyStepCount = 0; // Reset anti-loop counter
                        if (response.requires_user_input === true) {
                            isDone = true;
                            updateStatus(tr('status-awaiting-response'));
                            addLog(tr('log-modal-pause-required'), 'warning');
                        } else if (response.is_task_complete === false) {
                        sfx.taskComplete();
                            isDone = false;
                            currentPrompt = "ExtendScript step executed successfully. Awaiting your next instructions.";
                            aeContext = await agent.getAEContext();
                            addLog(tr('log-agent-continues-orchestration'), 'info');
                            showTyping();
                        } else {
                            isDone = true;
                            updateStatus(tr('status-done'));
                        }
                    } else {
                        var codeLines = extCode.split('\n');
                        var errorLine = aeResult.line || 0;
                        var ctxStart = Math.max(0, errorLine - 3);
                        var ctxEnd = Math.min(codeLines.length, errorLine + 2);
                        var codeFragment = codeLines.slice(ctxStart, ctxEnd).map(function(l, i) {
                            var ln = ctxStart + i + 1;
                            return (ln === errorLine ? ' >>> ' : '     ') + ln + ': ' + l;
                        }).join('\n');
                        lastError = 'Linia: ' + aeResult.line + '. Blad: ' + aeResult.error + '\n--- Fragment kodu ---\n' + codeFragment + '\n--- Pelny kod ---\n' + extCode;
                        addLog(tr('log-extendscript-error').replace('{line}', aeResult.line).replace('{err}', aeResult.error), 'error');
                    sfx.error();
                        appendMessage('assistant', (maxRetries > 0 ? tr('amsg-code-error-fixing') : tr('amsg-code-error-stopped')).replace('{err}', aeResult.error));
                        console.error(lastError);
                        if (retryCount >= maxRetries) {
                            isDone = true;
                            addLog(tr('log-exhausted-retries').replace('{max}', maxRetries), 'error');
                            updateStatus(tr('status-task-error'));
                        } else {
                            retryCount++;
                            // Cofnij zmiany z nieudanego skryptu (Undo)
                            try {
                                await agent.runExtendScript('app.executeCommand(16);');
                                addLog(tr('log-undo-success'), 'warning');
                            } catch(undoErr) { addLog(tr('log-undo-failed'), 'error'); }
                            
                            // --- Checkpoint: compare state AFTER undo ---
                            if (checkpoint) {
                                try {
                                    const safeCP = checkpoint.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                                    const cpDiff = await new Promise((resolve) => {
                                        const csi = new CSInterface();
                                        csi.evalScript("compareCheckpoint('" + safeCP + "')", (r) => resolve(r));
                                    });
                                    const diffObj = JSON.parse(cpDiff);
                                    if (diffObj && !diffObj.clean && diffObj.diffs) {
                                        lastError += '\n--- CHECKPOINT DRIFT ---\n' + diffObj.diffs.join(', ');
                                        addLog('Checkpoint wykryl drift po Undo: ' + diffObj.diffs.join(', '), 'warning');
                                    } else {
                                        addLog('Checkpoint: stan po Undo zgodny.', 'success');
                                    }
                                } catch (cpCmpErr) { addLog('Checkpoint compare failed: ' + cpCmpErr, 'warning'); }
                            }
                            currentPrompt = "Your code or process produced an error. Try to fix it or use a different approach.";
                            addLog(tr('log-prep-self-repair').replace('{n}', retryCount), 'warning');
                        }
                    }
                } else {
                    // No code executed in this step
                    if (response.requires_user_input === true) {
                        isDone = true;
                        updateStatus('Oczekuje na odpowiedz.');
                        addLog('Przerwa wg zadania modelu (requires_user_input).', 'warning');
                    } else if (response.is_task_complete === false) {
                        // Check if this step had ANY productive output (parallel_tasks, render_preview, questions)
                        const hadParallelTasks = parallelPromises.length > 0;
                        const hadRenderPreview = response.render_preview;
                        const hadAttachFiles = response.attach_files && response.attach_files.length > 0;
                        const stepWasProductive = hadParallelTasks || hadRenderPreview || hadAttachFiles;

                        if (stepWasProductive) {
                            // Step did useful work (generated images/video/audio/etc), continue normally
                            emptyStepCount = 0;
                            isDone = false;
                            aeContext = await agent.getAEContext();
                            currentPrompt = "Assets generated. Continue with the next step of the plan.";
                            addLog('Agent kontynuuje po generowaniu zasobow.', 'info');
                            showTyping();
                        } else {
                            // Check if step had Python/WhisperX tasks (always productive, agent iterates)
                            if (response.parallel_tasks && (response.parallel_tasks.python || response.parallel_tasks.whisperx)) {
                                emptyStepCount = 0;
                                addLog('Krok produktywny (Python) - agent moze iterowac.', 'info');
                                currentPrompt = "Python results are in context. Analyze stdout/stderr. If errors — fix the script and rerun.";
                                isDone = false;
                                aeContext = await agent.getAEContext();
                                showTyping();
                            } else {
                            // TRULY empty step - no code, no tasks
                            emptyStepCount++;
                            
                            // Auto-detect completion: broad keyword check on message and plan
                            const msgLower = (messageOutput || '').toLowerCase();
                            const planStr = JSON.stringify(response.current_plan || []).toLowerCase();
                            const completionKeywords = ['zakonczon', 'gotow', 'komplet', 'finalizac', 'ukonczeni', 'zrealizowan', 'wykonan', 'oddaj', 'wszystko jest', 'pomóc', 'w czym', 'oto wynik', 'oto podsum', 'do zobaczenia', 'powodzeni', 'to tyle'];
                            const looksComplete = completionKeywords.some(kw => msgLower.includes(kw));
                            const allPlanDone = response.current_plan && response.current_plan.length > 0 && !planStr.includes('aktualnie') && (planStr.includes('zakonczon') || planStr.includes('gotowe') || planStr.includes('gotow'));
                            const hasMessage = messageOutput && messageOutput.trim().length > 10;
                            
                            if (looksComplete || allPlanDone) {
                                // Agent clearly indicates done — auto-complete IMMEDIATELY (no 3x wait)
                                isDone = true;
                                addLog('Zadanie zakonczone (auto-detect z wiadomosci/planu).', 'success');
                                sfx.taskComplete();
                                updateStatus('Zadanie zakonczone.');
                            } else if (hasMessage && emptyStepCount >= 1) {
                                // Agent sent a message but no code/tasks — check if it's a continuation message
                                const continueKeywords = ['uruchami', 'rozpoczyn', 'przygotow', 'za chwil', 'chwil', 'w nastep', 'kontynuu', 'ładuję', 'pobieram', 'analizuj', 'generuj', 'rozpoczynam'];
                                const msgIndicatesContinuation = continueKeywords.some(kw => msgLower.includes(kw));
                                
                                if (msgIndicatesContinuation) {
                                    // Agent said it's about to do something — give it one more chance
                                    addLog(tr('log-agent-resumes-prework'), 'info');
                                    currentPrompt = "Continue the work you announced. You MUST now deliver code or parallel_tasks!";
                                    isDone = false;
                                    aeContext = await agent.getAEContext();
                                    showTyping();
                                } else {
                                    isDone = true;
                                    addLog('Zadanie zakonczone (agent wyslal wiadomosc bez dalszych zadan).', 'success');
                                    sfx.taskComplete();
                                    updateStatus('Zadanie zakonczone.');
                                }
                            } else if (emptyStepCount >= 2) {
                                // Safety net: 2 empty iterations = force stop (reduced from 3)
                                isDone = true;
                                addLog('Brak dalszych instrukcji po 2 pustych krokach. Koncze.', 'warning');
                                sfx.taskComplete();
                                updateStatus('Zadanie zakonczone.');
                            } else if (lastError) {
                                currentPrompt = "An error appeared. Fix it and continue.";
                                if (retryCount >= maxRetries) { isDone = true; updateStatus('Przerwano po bledzie.'); break; }
                                retryCount++;
                                isDone = false;
                                aeContext = await agent.getAEContext();
                                showTyping();
                            } else {
                                currentPrompt = "CRITICAL: You provided neither code nor parallel_tasks this step. If the task is COMPLETE — set is_task_complete:true and write a short summary in message. If NOT — provide code or add parallel_tasks. THE NEXT EMPTY ITERATION WILL TERMINATE THE PROCESS!";
                                isDone = false;
                                aeContext = await agent.getAEContext();
                                addLog('Pusta iteracja ' + emptyStepCount + '/2 - brak kodu/zadan.', 'warning');
                                showTyping();
                            }
                            }
                        }
                    } else {
                         isDone = true;
                         addLog('Zakonczone. Brak dalszych instrukcji.', 'info');
                         updateStatus('Zadanie zakonczone.');
                    }
                }

            } catch (err) {
                hideTyping();
                if (err.message && err.message.includes('Unable to process input image')) {
                    addLog('Vision API nie moglby przetworzyc zrzutu ekranu - pomijam attachments i ponawiam.', 'warning');
                    sentAttachments = null; // Clear bad attachments
                    // Don't count as error - just retry without attachments
                    continue;
                } else if (agent.isAborted || err.name === 'AbortError' || err.message.includes('AbortError')) {
                    addLog(tr('log-process-cancelled-user'), "warning");
                    updateStatus(tr('status-task-interrupted'));
                    appendMessage('assistant', tr('amsg-task-aborted-user'));
                    isDone = true;
                } else if (err.message.includes('Model_JSON_Error')) {
                    addLog(tr('log-json-format-err').replace('{hint}', 'dump at C:\\tmp\\failed_json.txt; will retry: ' + (maxRetries > 0)), 'error');
                    console.error(err);
                    try {
                        const fs = require('fs');
                        fs.writeFileSync('C:\\tmp\\failed_json.txt', err.message + '\n\n' + err.stack);
                    } catch(fserr) {}
                    if (retryCount >= maxRetries) {
                        isDone = true;
                        updateStatus(tr('status-json-recovery-aborted'));
                        appendMessage('assistant', tr('sysmsg-json-recovery-failed'));
                    } else {
                        retryCount++;
                        lastError = null;
                        currentPrompt = 'ERROR: Your previous response was not valid JSON. Reply ONLY with a clean JSON object, no markdown. Continue the task.';
                        addLog(tr('log-self-repair-syntax').replace('{n}', retryCount), 'warning');
                        // Do not set isDone = true, let loop continue
                    }
                } else {
                    appendMessage('assistant', tr('sysmsg-comm-error').replace('{err}', err.message));
                    addLog(tr('log-app-exception').replace('{err}', err.message), 'error');
                    updateStatus(tr('status-comm-error'));
                    console.error(err);
                    isDone = true;
                }
            }
        }
        
        // --- KLUCZOWA ZMIANA: Zapis historii czatu na sam koniec procesu (i UI i Pamięci Agenta) ---
        saveSession();
        
        hideTyping();
        isAgentProcessing = false;
        stopBtn.classList.add('hidden');
        sendBtn.classList.remove('hidden');
        
        if (thinkingVideo) {
            thinkingVideo.classList.remove('active');
            setTimeout(() => {
                if (!thinkingVideo.classList.contains('active')) thinkingVideo.pause();
            }, 1500);
        }
    }
});
