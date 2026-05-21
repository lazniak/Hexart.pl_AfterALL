// =====================================================================
// HEXART.PL/AfterALL — ElevenLabs Client
// =====================================================================
// Covers:
//   • Voice library discovery (public + user voices) with filtering
//   • Models list (loaded dynamically)
//   • Text-to-Speech with full voice settings (stability, similarity, style)
//   • Speech-to-Text (Scribe v1) with word-level timings
// =====================================================================

(function (global) {
    'use strict';

    const API_BASE = 'https://api.elevenlabs.io';

    // Shared HTTP helper — reuses providers.js helper if available, otherwise fetch
    function _http() {
        if (global.AfterAllProviders && global.AfterAllProviders.httpJSON) {
            return global.AfterAllProviders.httpJSON;
        }
        return async (url, opts) => {
            const res = await fetch(url, opts || {});
            const txt = await res.text();
            let json = null;
            try { json = txt ? JSON.parse(txt) : null; } catch (_) { /* ignore */ }
            if (!res.ok) {
                const msg = (json && json.detail && json.detail.message) || (json && json.detail) || txt || ('HTTP ' + res.status);
                const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
                e.status = res.status;
                throw e;
            }
            return json !== null ? json : txt;
        };
    }

    class ElevenLabsClient {
        constructor(cfg) {
            this.cfg = cfg || {};
            this.apiKey = this.cfg.apiKey || '';
            this._modelsCache = { list: null, ts: 0 };
            this._userVoicesCache = { list: null, ts: 0 };
            this.CACHE_TTL = 15 * 60 * 1000;
        }

        setApiKey(k) { this.apiKey = k || ''; }

        _headers(extra) {
            const h = { 'xi-api-key': this.apiKey };
            if (extra) Object.assign(h, extra);
            return h;
        }

        async listModels(force) {
            const now = Date.now();
            if (!force && this._modelsCache.list && (now - this._modelsCache.ts) < this.CACHE_TTL) {
                return this._modelsCache.list;
            }
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            const http = _http();
            const data = await http(API_BASE + '/v1/models', { method: 'GET', headers: this._headers() });
            const arr = Array.isArray(data) ? data : (data.models || []);
            const list = arr.map(m => ({
                id: m.model_id || m.id,
                name: m.name || m.model_id,
                description: m.description || '',
                languages: (m.languages || []).map(l => l.language_id || l.name),
                canDoTTS: !!m.can_do_text_to_speech,
                canDoSTT: !!(m.can_do_speech_to_text || /scribe/i.test(m.model_id || '')),
                canBeFinetuned: !!m.can_be_finetuned,
                requiresAlphaAccess: !!m.requires_alpha_access,
                maxCharsFree: m.max_characters_request_free_user,
                maxCharsSub: m.max_characters_request_subscribed_user,
                raw: m
            }));
            this._modelsCache = { list, ts: now };
            return list;
        }

        async listUserVoices(force) {
            const now = Date.now();
            if (!force && this._userVoicesCache.list && (now - this._userVoicesCache.ts) < this.CACHE_TTL) {
                return this._userVoicesCache.list;
            }
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            const http = _http();
            const data = await http(API_BASE + '/v1/voices', { method: 'GET', headers: this._headers() });
            const list = (data.voices || []).map(v => this._normaliseVoice(v, 'user'));
            this._userVoicesCache = { list, ts: now };
            return list;
        }

        // Search the public Voice Library — uses /v1/shared-voices
        // filters: { gender, age, accent, use_case, language, search, page_size, sort, page, featured }
        // Returns: { voices: [...], hasMore: boolean, page: int, pageSize: int, total: int|null }
        async searchVoiceLibrary(filters) {
            if (!this.apiKey) throw new Error('Missing ElevenLabs API key.');
            const http = _http();
            const params = new URLSearchParams();
            filters = filters || {};
            if (filters.gender) params.set('gender', filters.gender);
            if (filters.age) params.set('age', filters.age);
            if (filters.accent) params.set('accent', filters.accent);
            if (filters.use_case) params.set('use_cases', filters.use_case);
            if (filters.language) params.set('language', filters.language);
            if (filters.search) params.set('search', filters.search);
            if (filters.sort) params.set('sort', filters.sort);
            const pageSize = Math.min(100, Math.max(1, filters.page_size || 100));
            const page = Math.max(0, parseInt(filters.page, 10) || 0);
            params.set('page_size', String(pageSize));
            params.set('page', String(page));
            // Only force featured=true when explicitly requested. Default is to
            // let the server decide (omitting the param returns the full set
            // sorted by `sort`, so users can scroll the entire library).
            if (filters.featured === true) params.set('featured', 'true');
            const url = API_BASE + '/v1/shared-voices?' + params.toString();
            const data = await http(url, { method: 'GET', headers: this._headers() });
            const arr = data.voices || data.shared_voices || [];
            // The API exposes `has_more` (boolean). If absent, infer from
            // whether the response was a full page.
            const hasMore = (typeof data.has_more === 'boolean')
                ? data.has_more
                : (arr.length >= pageSize);
            return {
                voices: arr.map(v => this._normaliseVoice(v, 'library')),
                hasMore: hasMore,
                page: page,
                pageSize: pageSize,
                total: (typeof data.total === 'number') ? data.total : null
            };
        }

        // Add a shared voice to the user's library — required before using it for TTS.
        async addSharedVoice(publicUserId, voiceId, newName) {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            const http = _http();
            const url = API_BASE + '/v1/voices/add/' + encodeURIComponent(publicUserId) + '/' + encodeURIComponent(voiceId);
            const data = await http(url, {
                method: 'POST',
                headers: this._headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ new_name: newName || ('Imported_' + voiceId.substring(0, 6)) })
            });
            // Invalidate user voices cache so next list call refetches
            this._userVoicesCache = { list: null, ts: 0 };
            return data;
        }

        // Normalize voice object from either /v1/voices or /v1/shared-voices
        _normaliseVoice(v, source) {
            const labels = v.labels || {};
            // Library voices have keys: gender, age, accent, use_case, descriptive
            // User voices wrap them under "labels"
            const gender = (labels.gender || v.gender || '').toLowerCase();
            const age = (labels.age || v.age || '').toLowerCase();
            const accent = (labels.accent || v.accent || '').toLowerCase();
            const useCase = (labels.use_case || labels.use_cases || v.use_case || '').toLowerCase();
            return {
                voice_id: v.voice_id || v.id,
                public_owner_id: v.public_owner_id || v.public_user_id || null,
                name: v.name,
                description: labels.description || v.description || labels.descriptive || '',
                gender: gender,
                age: age,
                accent: accent,
                useCase: useCase,
                language: v.language || labels.language || '',
                preview_url: v.preview_url || null,
                category: v.category || '',
                source: source,
                isCloned: v.category === 'cloned' || v.category === 'generated' || v.category === 'professional',
                liked_count: v.liked_count_total || v.cloned_by_count || 0,
                raw: v
            };
        }

        // Text-to-Speech
        // voiceSettings: { stability, similarity_boost, style, use_speaker_boost, speed }
        // outputFormat: e.g. 'mp3_44100_128', 'pcm_24000', 'pcm_16000'
        async textToSpeech(text, voiceId, modelId, voiceSettings, outputFormat, signal) {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            if (!voiceId) throw new Error('Nie wybrano voice_id ElevenLabs.');
            const fmt = outputFormat || 'mp3_44100_128';
            const url = API_BASE + '/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=' + encodeURIComponent(fmt);
            const body = {
                text: text,
                model_id: modelId || 'eleven_multilingual_v2',
                voice_settings: Object.assign({
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true
                }, voiceSettings || {})
            };
            const res = await fetch(url, {
                method: 'POST',
                headers: this._headers({ 'Content-Type': 'application/json', 'Accept': 'audio/*' }),
                body: JSON.stringify(body),
                signal: signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                let parsed = null;
                try { parsed = JSON.parse(errTxt); } catch (_) {}
                const msg = (parsed && parsed.detail && parsed.detail.message) || (parsed && parsed.detail) || errTxt || ('HTTP ' + res.status);
                throw new Error('ElevenLabs TTS: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
            }
            const buf = await res.arrayBuffer();
            return {
                buffer: buf,
                format: fmt,
                mimeType: fmt.startsWith('mp3') ? 'audio/mpeg'
                        : fmt.startsWith('pcm') ? 'audio/x-pcm'
                        : fmt.startsWith('ulaw') ? 'audio/basic'
                        : fmt.startsWith('opus') ? 'audio/opus'
                        : 'audio/mpeg'
            };
        }

        // Speech-to-Text (Scribe). audioBuffer: Buffer or Blob
        async speechToText(audioBuffer, modelId, opts) {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            const url = API_BASE + '/v1/speech-to-text';
            opts = opts || {};
            const blob = (audioBuffer instanceof Blob)
                ? audioBuffer
                : new Blob([audioBuffer], { type: opts.mimeType || 'audio/wav' });
            const form = new FormData();
            form.append('file', blob, opts.filename || 'audio.wav');
            form.append('model_id', modelId || 'scribe_v2');
            if (opts.language_code) form.append('language_code', opts.language_code);
            if (opts.tag_audio_events !== undefined) form.append('tag_audio_events', String(opts.tag_audio_events));
            if (opts.diarize !== undefined) form.append('diarize', String(opts.diarize));
            if (opts.num_speakers) form.append('num_speakers', String(opts.num_speakers));
            const res = await fetch(url, {
                method: 'POST',
                headers: this._headers(),
                body: form,
                signal: opts.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                throw new Error('ElevenLabs STT: ' + errTxt);
            }
            return await res.json();
        }

        // User subscription info — useful for displaying char limits
        async getUserInfo() {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            const http = _http();
            return await http(API_BASE + '/v1/user', { method: 'GET', headers: this._headers() });
        }

        // ------- Sound Effects (Text-to-SFX) ------------------------------
        // POST /v1/sound-generation
        // Body: { text, duration_seconds?, prompt_influence?, model_id?, loop? }
        // Query: output_format (mp3_44100_128 / pcm_44100 / pcm_24000 / pcm_16000 / opus_48000_*)
        // duration_seconds: 0.5 - 22 (server clamps). Omit for auto.
        // prompt_influence: 0.0 - 1.0 (default 0.3). Higher = more literal interpretation.
        // model_id: e.g. "eleven_text_to_sound_v2" (auto picked server-side if omitted)
        async generateSFX(text, opts) {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            opts = opts || {};
            const fmt = opts.outputFormat || 'mp3_44100_128';
            const url = API_BASE + '/v1/sound-generation?output_format=' + encodeURIComponent(fmt);
            const body = {
                text: String(text || '').trim()
            };
            if (body.text.length === 0) throw new Error('SFX: prompt jest pusty.');
            if (opts.duration_seconds != null) {
                let d = parseFloat(opts.duration_seconds);
                if (!isNaN(d)) {
                    d = Math.max(0.5, Math.min(22, d));
                    body.duration_seconds = d;
                }
            }
            if (opts.prompt_influence != null) {
                let p = parseFloat(opts.prompt_influence);
                if (!isNaN(p)) {
                    p = Math.max(0, Math.min(1, p));
                    body.prompt_influence = p;
                }
            }
            if (opts.model_id) body.model_id = opts.model_id;
            if (opts.loop === true) body.loop = true;

            const res = await fetch(url, {
                method: 'POST',
                headers: this._headers({ 'Content-Type': 'application/json', 'Accept': 'audio/*' }),
                body: JSON.stringify(body),
                signal: opts.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                let parsed = null;
                try { parsed = JSON.parse(errTxt); } catch (_) {}
                const msg = (parsed && parsed.detail && parsed.detail.message) || (parsed && parsed.detail) || errTxt || ('HTTP ' + res.status);
                throw new Error('ElevenLabs SFX: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
            }
            const buf = await res.arrayBuffer();
            return {
                buffer: buf,
                format: fmt,
                mimeType: fmt.startsWith('mp3') ? 'audio/mpeg'
                        : fmt.startsWith('pcm') ? 'audio/x-pcm'
                        : fmt.startsWith('opus') ? 'audio/opus'
                        : 'audio/mpeg'
            };
        }

        // ------- Music Generation (Eleven Music) --------------------------
        // POST /v1/music
        // Body: { prompt, music_length_ms?, composition_plan?, model_id?, force_instrumental? }
        // Query: output_format
        // music_length_ms: 10000 - 300000 (10 s - 5 min); will be clamped server-side.
        // composition_plan: optional ElevenLabs JSON describing structure (sections, tempo).
        // force_instrumental: true to skip vocals
        async composeMusic(prompt, opts) {
            if (!this.apiKey) throw new Error('Brak klucza ElevenLabs.');
            opts = opts || {};
            const fmt = opts.outputFormat || 'mp3_44100_128';
            const url = API_BASE + '/v1/music?output_format=' + encodeURIComponent(fmt);
            const body = {
                prompt: String(prompt || '').trim()
            };
            if (body.prompt.length === 0) throw new Error('Music: prompt jest pusty.');
            if (opts.music_length_ms != null) {
                let ms = parseInt(opts.music_length_ms, 10);
                if (!isNaN(ms)) {
                    ms = Math.max(10000, Math.min(300000, ms));
                    body.music_length_ms = ms;
                }
            } else if (opts.duration_seconds != null) {
                const ms = Math.max(10, Math.min(300, parseFloat(opts.duration_seconds))) * 1000;
                body.music_length_ms = Math.round(ms);
            }
            if (opts.model_id) body.model_id = opts.model_id;
            if (opts.composition_plan && typeof opts.composition_plan === 'object') {
                body.composition_plan = opts.composition_plan;
            }
            if (opts.force_instrumental === true) body.force_instrumental = true;

            const res = await fetch(url, {
                method: 'POST',
                headers: this._headers({ 'Content-Type': 'application/json', 'Accept': 'audio/*' }),
                body: JSON.stringify(body),
                signal: opts.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                let parsed = null;
                try { parsed = JSON.parse(errTxt); } catch (_) {}
                const msg = (parsed && parsed.detail && parsed.detail.message) || (parsed && parsed.detail) || errTxt || ('HTTP ' + res.status);
                throw new Error('ElevenLabs Music: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
            }
            const buf = await res.arrayBuffer();
            return {
                buffer: buf,
                format: fmt,
                mimeType: fmt.startsWith('mp3') ? 'audio/mpeg'
                        : fmt.startsWith('pcm') ? 'audio/x-pcm'
                        : fmt.startsWith('opus') ? 'audio/opus'
                        : 'audio/mpeg'
            };
        }
    }

    global.AfterAllElevenLabs = ElevenLabsClient;
})(typeof window !== 'undefined' ? window : globalThis);
