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
        // Streaming chat completion. onChunk(deltaText, fullText) called per chunk.
        // Default fallback: call non-streaming and emit a single final chunk.
        async streamChatCompletion(args, onChunk) {
            const result = await this.chatCompletion(args);
            if (onChunk && result && result.text) {
                try { onChunk(result.text, result.text); } catch (_) {}
            }
            return result;
        }
        // Image generation — Promise<{ mimeType, data (base64) }>
        async generateImage(args) { throw new Error('not implemented'); }
    }

    // -----------------------------------------------------------------
    // Shared SSE consumer — reads a Response.body stream line by line,
    // extracts text deltas using a provider-specific extractor function.
    // Cancellation: respect signal.aborted at every iteration.
    // -----------------------------------------------------------------
    async function consumeSSE(res, extract, onChunk, signal) {
        if (!res.body || !res.body.getReader) {
            // No streaming support — fall back to full body parse
            const txt = await res.text();
            const lines = txt.split('\n');
            let full = '';
            for (const line of lines) {
                const data = line.startsWith('data: ') ? line.slice(6).trim() : '';
                if (!data || data === '[DONE]') continue;
                try {
                    const delta = extract(JSON.parse(data));
                    if (delta) { full += delta; if (onChunk) onChunk(delta, full); }
                } catch (_) {}
            }
            return full;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        while (true) {
            if (signal && signal.aborted) {
                try { reader.cancel(); } catch (_) {}
                break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE event boundary is a blank line (\n\n).
            const events = buffer.split(/\n\n/);
            buffer = events.pop(); // keep partial last event
            for (const evt of events) {
                for (const line of evt.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const delta = extract(JSON.parse(data));
                        if (delta) {
                            full += delta;
                            if (onChunk) {
                                try { onChunk(delta, full); } catch (_) {}
                            }
                        }
                    } catch (_) {
                        // partial / non-JSON chunk — ignore quietly
                    }
                }
            }
        }
        return full;
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

        _buildGenPayload(args) {
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
            return payload;
        }

        async chatCompletion(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const model = args.model || 'gemini-2.5-flash';
            const url = this.apiBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(this.cfg.apiKey);
            const payload = this._buildGenPayload(args);
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

        async streamChatCompletion(args, onChunk) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const model = args.model || 'gemini-2.5-flash';
            // streamGenerateContent + alt=sse → clean Server-Sent Events with `data: {...}\n\n` framing
            const url = this.apiBase + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(this.cfg.apiKey);
            const payload = this._buildGenPayload(args);
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload),
                signal: args.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                throw new Error('Gemini stream HTTP ' + res.status + ': ' + errTxt.substring(0, 300));
            }
            const extract = (obj) => {
                const parts = obj && obj.candidates && obj.candidates[0]
                    && obj.candidates[0].content && obj.candidates[0].content.parts || [];
                let s = '';
                for (const p of parts) if (p && p.text) s += p.text;
                return s;
            };
            const full = await consumeSSE(res, extract, onChunk, args.signal);
            return { text: full, raw: { streamed: true } };
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

        _buildOAIPayload(args, stream) {
            const payload = {
                model: args.model,
                messages: OpenRouterProvider.geminiToOpenAI(args.systemInstruction, args.messages),
                temperature: (args.generationConfig && args.generationConfig.temperature != null)
                    ? args.generationConfig.temperature : 0.2,
                max_tokens: (args.generationConfig && args.generationConfig.maxOutputTokens) || 16384
            };
            if (args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
                payload.response_format = { type: 'json_object' };
            }
            if (stream) payload.stream = true;
            return payload;
        }
        _oaiHeaders() {
            return {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.cfg.apiKey,
                'HTTP-Referer': 'https://hexart.pl',
                'X-Title': 'HEXART.PL/AfterALL'
            };
        }

        async chatCompletion(args) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza OpenRouter API.');
            if (!args.model) throw new Error('Wybierz model OpenRouter w ustawieniach.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildOAIPayload(args, false);
            const data = await httpJSON(url, {
                method: 'POST',
                headers: this._oaiHeaders(),
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

        async streamChatCompletion(args, onChunk) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza OpenRouter API.');
            if (!args.model) throw new Error('Wybierz model OpenRouter w ustawieniach.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildOAIPayload(args, true);
            const res = await fetch(url, {
                method: 'POST',
                headers: Object.assign(this._oaiHeaders(), { 'Accept': 'text/event-stream' }),
                body: JSON.stringify(payload),
                signal: args.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                throw new Error('OpenRouter stream HTTP ' + res.status + ': ' + errTxt.substring(0, 300));
            }
            const extract = (obj) => {
                const choices = obj && obj.choices || [];
                let s = '';
                for (const c of choices) {
                    const delta = c && c.delta;
                    if (!delta) continue;
                    if (typeof delta.content === 'string') s += delta.content;
                    else if (Array.isArray(delta.content)) {
                        for (const part of delta.content) if (part && part.text) s += part.text;
                    }
                }
                return s;
            };
            const full = await consumeSSE(res, extract, onChunk, args.signal);
            return { text: full, raw: { streamed: true } };
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

        _buildPayload(args, stream) {
            const payload = {
                model: args.model,
                messages: OpenRouterProvider.geminiToOpenAI(args.systemInstruction, args.messages),
                temperature: (args.generationConfig && args.generationConfig.temperature != null)
                    ? args.generationConfig.temperature : 0.2,
                max_tokens: (args.generationConfig && args.generationConfig.maxOutputTokens) || 8192,
                stream: !!stream
            };
            if (args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
                payload.response_format = { type: 'json_object' };
            }
            return payload;
        }

        async chatCompletion(args) {
            if (!args.model) throw new Error('Wybierz model LM Studio.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildPayload(args, false);
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

        async streamChatCompletion(args, onChunk) {
            if (!args.model) throw new Error('Wybierz model LM Studio.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildPayload(args, true);
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify(payload),
                signal: args.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                throw new Error('LM Studio stream HTTP ' + res.status + ': ' + errTxt.substring(0, 300));
            }
            const extract = (obj) => {
                const choices = obj && obj.choices || [];
                let s = '';
                for (const c of choices) {
                    if (c && c.delta && typeof c.delta.content === 'string') s += c.delta.content;
                }
                return s;
            };
            const full = await consumeSSE(res, extract, onChunk, args.signal);
            return { text: full, raw: { streamed: true } };
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
