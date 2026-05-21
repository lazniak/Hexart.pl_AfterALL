// =====================================================================
// HEXART.PL/AfterALL — Multi-Provider LLM/Image Abstraction Layer
// =====================================================================
// Providers supported:
//   • Gemini (Google Generative Language API)
//   • OpenRouter (OpenAI-compatible aggregator with 200+ models)
//   • LM Studio (local OpenAI-compatible server)
// =====================================================================

(function (global) {
    'use strict';

    // ---- shared HTTP helpers with retry/backoff -----------------------
    const DEFAULT_TIMEOUT_MS = 120000;
    const MAX_RETRIES = 2;

    async function httpJSON(url, options, opts) {
        opts = opts || {};
        const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        const retries = opts.retries == null ? MAX_RETRIES : opts.retries;
        let lastErr = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            const ctrl = new AbortController();
            const tHandle = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
            try {
                const reqOpts = Object.assign({}, options, {
                    signal: opts.signal || ctrl.signal
                });
                const res = await fetch(url, reqOpts);
                clearTimeout(tHandle);
                if (res.status === 429 && attempt < retries) {
                    // exponential backoff for rate-limit
                    const wait = Math.min(8000, 800 * Math.pow(2, attempt));
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                if (!res.ok && res.status >= 500 && attempt < retries) {
                    const wait = Math.min(4000, 400 * Math.pow(2, attempt));
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                const text = await res.text();
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
                if (!res.ok) {
                    const msg = (json && json.error && (json.error.message || json.error)) || text || ('HTTP ' + res.status);
                    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
                    e.status = res.status;
                    e.body = json || text;
                    throw e;
                }
                return json !== null ? json : text;
            } catch (e) {
                clearTimeout(tHandle);
                lastErr = e;
                if (e.name === 'AbortError') {
                    if (opts.signal && opts.signal.aborted) throw e; // user abort — bail immediately
                    if (attempt >= retries) throw e;
                    continue;
                }
                if (attempt >= retries) throw e;
            }
        }
        throw lastErr || new Error('HTTP failed');
    }

    // =================================================================
    // Provider Base Class
    // =================================================================
    class BaseProvider {
        constructor(cfg) {
            this.cfg = cfg || {};
        }
        // List models — returns Promise<Array<{ id, name, provider, contextLength?, pricing?, features? }>>
        async listLLMModels() { throw new Error('not implemented'); }
        async listImageModels() { return []; }
        // Chat completion. Args: { systemInstruction, messages, model, attachments, generationConfig, signal, grounding }
        // Must return text content of the model response.
        async chatCompletion(args) { throw new Error('not implemented'); }
        // Image generation — Promise<{ mimeType, data (base64) }>
        async generateImage(args) { throw new Error('not implemented'); }
    }

    // =================================================================
    // Gemini Provider
    // =================================================================
    class GeminiProvider extends BaseProvider {
        get apiBase() { return 'https://generativelanguage.googleapis.com/v1beta'; }

        async listLLMModels() {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const url = this.apiBase + '/models?key=' + encodeURIComponent(this.cfg.apiKey) + '&pageSize=1000';
            const data = await httpJSON(url, { method: 'GET' }, { timeoutMs: 30000, retries: 1 });
            const models = (data.models || [])
                .filter(m => {
                    const methods = m.supportedGenerationMethods || [];
                    return methods.indexOf('generateContent') !== -1;
                })
                .map(m => {
                    const id = (m.name || '').replace(/^models\//, '');
                    return {
                        id: id,
                        name: m.displayName || id,
                        provider: 'gemini',
                        contextLength: m.inputTokenLimit || null,
                        outputLimit: m.outputTokenLimit || null,
                        description: m.description || '',
                        version: m.version || '',
                        features: {
                            vision: /vision|pro|flash|gemini-[23]/i.test(id),
                            tools: /pro|flash|gemini-[23]/i.test(id),
                            json: true
                        }
                    };
                })
                .sort((a, b) => a.id.localeCompare(b.id));
            return models;
        }

        async listImageModels() {
            const all = await this.listLLMModels();
            // Image-capable Gemini models — anything with "image" in name or known image families
            return all.filter(m => /image|imagen|flash-image|pro-image/i.test(m.id));
        }

        async listTTSModels() {
            const all = await this.listLLMModels();
            return all.filter(m => /tts/i.test(m.id));
        }

        async chatCompletion(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const model = args.model || 'gemini-2.5-flash';
            const url = this.apiBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(this.cfg.apiKey);
            const payload = {
                contents: args.messages,
                generationConfig: Object.assign({
                    temperature: 0.2,
                    maxOutputTokens: 16384,
                    responseMimeType: 'application/json'
                }, args.generationConfig || {})
            };
            if (args.systemInstruction) {
                payload.systemInstruction = { parts: [{ text: args.systemInstruction }] };
            }
            if (args.grounding) {
                payload.tools = [{ google_search: {} }];
            }
            const data = await httpJSON(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 180000, signal: args.signal, retries: 1 });
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                const reason = data.promptFeedback ? JSON.stringify(data.promptFeedback) : 'brak candidates';
                throw new Error('Pusta odpowiedz Gemini: ' + reason);
            }
            const parts = data.candidates[0].content.parts || [];
            let text = '';
            for (const p of parts) { if (p.text) text += p.text; }
            return { text: text, raw: data };
        }

        async generateImage(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const model = args.model || 'gemini-2.5-flash-image-preview';
            const url = this.apiBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(this.cfg.apiKey);
            const parts = [{ text: args.prompt }];
            if (args.referenceImages && args.referenceImages.length) {
                args.referenceImages.forEach(img => {
                    if (img && img.data && img.mimeType) {
                        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
                    }
                });
            }
            const payload = {
                contents: [{ parts: parts }],
                generationConfig: { responseModalities: ['IMAGE'] }
            };
            const data = await httpJSON(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 240000, signal: args.signal, retries: 1 });
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                throw new Error('Pusta odpowiedz Gemini Image.');
            }
            for (const p of (data.candidates[0].content.parts || [])) {
                if (p.inlineData && p.inlineData.data) return p.inlineData;
            }
            throw new Error('Gemini Image: brak danych obrazu w odpowiedzi.');
        }
    }

    // =================================================================
    // OpenRouter Provider (OpenAI-compatible)
    // =================================================================
    class OpenRouterProvider extends BaseProvider {
        get apiBase() { return 'https://openrouter.ai/api/v1'; }

        async listLLMModels() {
            // OpenRouter /models endpoint is public — works even without key for listing
            const url = this.apiBase + '/models';
            const headers = { 'Content-Type': 'application/json' };
            if (this.cfg.apiKey) headers['Authorization'] = 'Bearer ' + this.cfg.apiKey;
            const data = await httpJSON(url, { method: 'GET', headers: headers }, { timeoutMs: 30000, retries: 1 });
            const out = (data.data || data.models || []).map(m => {
                const arch = m.architecture || {};
                const pricing = m.pricing || {};
                const features = {
                    vision: (arch.input_modalities || arch.modality || '').toString().toLowerCase().indexOf('image') !== -1
                        || (m.supported_parameters || []).indexOf('vision') !== -1,
                    tools: (m.supported_parameters || []).some(p => /tool|function/i.test(p)),
                    json: (m.supported_parameters || []).indexOf('response_format') !== -1,
                    imageOutput: (arch.output_modalities || []).toString().toLowerCase().indexOf('image') !== -1
                };
                const promptPrice = parseFloat(pricing.prompt || '0') || 0;
                const completionPrice = parseFloat(pricing.completion || '0') || 0;
                const imagePrice = parseFloat(pricing.image || '0') || 0;
                const isFree = (promptPrice === 0 && completionPrice === 0) || /:free$/i.test(m.id || '');
                return {
                    id: m.id,
                    name: m.name || m.id,
                    provider: 'openrouter',
                    contextLength: m.context_length || null,
                    description: m.description || '',
                    pricing: {
                        prompt: promptPrice,         // USD / token
                        completion: completionPrice, // USD / token
                        image: imagePrice,           // USD / image
                        // pre-computed USD per 1M tokens for the picker
                        promptPerMTok: promptPrice * 1_000_000,
                        completionPerMTok: completionPrice * 1_000_000
                    },
                    features: features,
                    isFree: isFree,
                    providerName: (m.id || '').split('/')[0] || 'unknown',
                    raw: m
                };
            });
            return out;
        }

        async listImageModels() {
            const all = await this.listLLMModels();
            return all.filter(m => m.features && m.features.imageOutput);
        }

        // Convert Gemini "contents" structure to OpenAI-style messages
        static geminiToOpenAI(systemInstruction, contents) {
            const out = [];
            if (systemInstruction) out.push({ role: 'system', content: systemInstruction });
            (contents || []).forEach(turn => {
                const role = turn.role === 'model' ? 'assistant' : turn.role;
                const parts = turn.parts || [];
                // Mixed parts (text + image) — encode as multimodal content array
                const mm = [];
                let txt = '';
                parts.forEach(p => {
                    if (p.text) { txt += p.text; }
                    else if (p.inlineData) {
                        mm.push({
                            type: 'image_url',
                            image_url: { url: 'data:' + p.inlineData.mimeType + ';base64,' + p.inlineData.data }
                        });
                    }
                });
                if (mm.length > 0) {
                    if (txt) mm.unshift({ type: 'text', text: txt });
                    out.push({ role: role, content: mm });
                } else {
                    out.push({ role: role, content: txt });
                }
            });
            return out;
        }

        async chatCompletion(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza OpenRouter API.');
            const model = args.model;
            if (!model) throw new Error('Wybierz model OpenRouter w ustawieniach.');
            const url = this.apiBase + '/chat/completions';
            const messages = OpenRouterProvider.geminiToOpenAI(args.systemInstruction, args.messages);
            const payload = {
                model: model,
                messages: messages,
                temperature: (args.generationConfig && args.generationConfig.temperature != null)
                    ? args.generationConfig.temperature : 0.2,
                max_tokens: (args.generationConfig && args.generationConfig.maxOutputTokens) || 16384
            };
            // OpenRouter supports response_format for json_object on capable models
            if (args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
                payload.response_format = { type: 'json_object' };
            }
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.cfg.apiKey,
                'HTTP-Referer': 'https://hexart.pl',
                'X-Title': 'HEXART.PL/AfterALL'
            };
            const data = await httpJSON(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 180000, signal: args.signal, retries: 1 });
            if (!data.choices || !data.choices[0]) {
                throw new Error('OpenRouter: pusta odpowiedz. ' + (data.error ? JSON.stringify(data.error) : ''));
            }
            const msg = data.choices[0].message || {};
            const text = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
            return { text: text, raw: data };
        }

        async generateImage(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza OpenRouter API.');
            const model = args.model;
            if (!model) throw new Error('Wybierz model obrazów OpenRouter.');
            // OpenRouter routes image generation through /chat/completions with modalities array
            const url = this.apiBase + '/chat/completions';
            const content = [{ type: 'text', text: args.prompt }];
            if (args.referenceImages && args.referenceImages.length) {
                args.referenceImages.forEach(img => {
                    if (img && img.data && img.mimeType) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: 'data:' + img.mimeType + ';base64,' + img.data }
                        });
                    }
                });
            }
            const payload = {
                model: model,
                messages: [{ role: 'user', content: content }],
                modalities: ['image', 'text']
            };
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.cfg.apiKey,
                'HTTP-Referer': 'https://hexart.pl',
                'X-Title': 'HEXART.PL/AfterALL'
            };
            const data = await httpJSON(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 240000, signal: args.signal, retries: 1 });
            const msg = data.choices && data.choices[0] && data.choices[0].message;
            if (!msg) throw new Error('OpenRouter Image: pusta odpowiedz.');
            const images = msg.images || [];
            for (const img of images) {
                if (img.image_url && img.image_url.url) {
                    const url = img.image_url.url;
                    const m = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (m) return { mimeType: m[1], data: m[2] };
                }
            }
            throw new Error('OpenRouter: model nie zwrocil obrazu — wybierz model z funkcja "Generuje obrazy".');
        }
    }

    // =================================================================
    // LM Studio Provider (local, OpenAI-compatible)
    // =================================================================
    class LMStudioProvider extends BaseProvider {
        get apiBase() {
            const base = (this.cfg.baseUrl || 'http://localhost:1234').replace(/\/+$/, '');
            return base + '/v1';
        }

        async listLLMModels() {
            const url = this.apiBase + '/models';
            let data;
            try {
                data = await httpJSON(url, { method: 'GET' }, { timeoutMs: 8000, retries: 0 });
            } catch (e) {
                throw new Error('Nie udało się połączyć z LM Studio (' + this.apiBase + '). Uruchom serwer LM Studio (Server Mode → Start).');
            }
            const list = (data.data || []).map(m => ({
                id: m.id,
                name: m.id,
                provider: 'lmstudio',
                contextLength: m.context_length || null,
                features: { vision: /vision|llava|multi/i.test(m.id), tools: true, json: true },
                raw: m
            }));
            return list;
        }

        async chatCompletion(args) {
            const model = args.model;
            if (!model) throw new Error('Wybierz model LM Studio.');
            const url = this.apiBase + '/chat/completions';
            const messages = OpenRouterProvider.geminiToOpenAI(args.systemInstruction, args.messages);
            const payload = {
                model: model,
                messages: messages,
                temperature: (args.generationConfig && args.generationConfig.temperature != null)
                    ? args.generationConfig.temperature : 0.2,
                max_tokens: (args.generationConfig && args.generationConfig.maxOutputTokens) || 8192,
                stream: false
            };
            if (args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
                payload.response_format = { type: 'json_object' };
            }
            const data = await httpJSON(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 240000, signal: args.signal, retries: 0 });
            if (!data.choices || !data.choices[0]) {
                throw new Error('LM Studio: pusta odpowiedz.');
            }
            const msg = data.choices[0].message || {};
            const text = typeof msg.content === 'string' ? msg.content : '';
            return { text: text, raw: data };
        }

        async generateImage() {
            throw new Error('LM Studio nie obsługuje generowania obrazów. Wybierz Gemini lub OpenRouter dla obrazów.');
        }
    }

    // =================================================================
    // Provider Registry
    // =================================================================
    const Providers = {
        BaseProvider,
        GeminiProvider,
        OpenRouterProvider,
        LMStudioProvider,
        // Factory
        create(name, cfg) {
            switch ((name || 'gemini').toLowerCase()) {
                case 'gemini': return new GeminiProvider(cfg || {});
                case 'openrouter': return new OpenRouterProvider(cfg || {});
                case 'lmstudio': return new LMStudioProvider(cfg || {});
                default: throw new Error('Nieznany provider: ' + name);
            }
        },
        // Expose http helper for advanced use
        httpJSON: httpJSON
    };

    global.AfterAllProviders = Providers;
})(typeof window !== 'undefined' ? window : globalThis);
