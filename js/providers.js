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

        // Gemini 2.5+ ("thinking") and 3.x models do extensive server-side
        // reasoning before emitting any output token. Without
        // thinkingConfig.includeThoughts, an SSE stream stays silent for
        // 30-90s and looks broken. With includeThoughts=true, the server
        // streams thought-summary parts (each carries thought: true) so the
        // user can watch the model reason live.
        _isThinkingModel(modelId) {
            if (!modelId) return false;
            // gemini-2.5-*, gemini-3-*, gemini-3.x-*  (excluding lite variants
            // which don't accept thinkingConfig). Lite still works without it.
            if (/gemini-[2-9]\.\d/i.test(modelId) && !/-lite/i.test(modelId)) return true;
            if (/^gemini-[3-9](-|$)/i.test(modelId)) return true;
            return false;
        }

        _buildGenPayload(args, stream) {
            // IMPORTANT: when streaming, we MUST NOT request
            // responseMimeType=application/json. Gemini's streaming endpoint
            // buffers the entire response server-side when JSON mode is on
            // (because partial JSON isn't a valid JSON document), so streaming
            // in JSON mode yields a single chunk at the very end and looks
            // identical to a non-streaming call. The system prompt already
            // tells the model to emit pure JSON, and the response parser is
            // tolerant of markdown fences and a tiny preamble.
            const baseGenCfg = Object.assign({
                temperature: 0.2,
                maxOutputTokens: 16384
            }, args.generationConfig || {});
            if (!stream) {
                // Non-streaming: keep the strict JSON-mode hint
                if (!baseGenCfg.responseMimeType) baseGenCfg.responseMimeType = 'application/json';
            } else {
                // Streaming: drop the JSON-mode hint so the server emits tokens
                // as they're generated.
                delete baseGenCfg.responseMimeType;
            }
            // Stream thought summaries for reasoning models so the live
            // thinking block actually shows activity during the server-side
            // reasoning phase. Non-thinking models silently ignore the field.
            if (stream && this._isThinkingModel(args.model)) {
                baseGenCfg.thinkingConfig = Object.assign({
                    includeThoughts: true
                }, baseGenCfg.thinkingConfig || {});
            }
            const payload = {
                contents: args.messages,
                generationConfig: baseGenCfg
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
            const payload = this._buildGenPayload(args, /* stream */ false);
            const data = await httpJSON(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 180000, signal: args.signal, retries: 1 });
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                const reason = data.promptFeedback ? JSON.stringify(data.promptFeedback) : 'no candidates returned';
                throw new Error('Gemini returned no candidates for model "' + model + '" (' + reason
                    + '). This often means the prompt was blocked by safety filters or the model is temporarily unavailable.');
            }
            const parts = data.candidates[0].content.parts || [];
            let text = '';
            for (const p of parts) { if (p.text) text += p.text; }
            if (!text.trim()) {
                const finish = data.candidates[0].finishReason || 'unknown';
                throw new Error('Gemini returned empty text for model "' + model
                    + '" (finishReason=' + finish + '). Try a different model or check the prompt for blocked content.');
            }
            return { text: text, raw: data };
        }

        async streamChatCompletion(args, onChunk) {
            if (!this.cfg.apiKey) throw new Error('Brak klucza Gemini API.');
            const model = args.model || 'gemini-2.5-flash';
            // Some Gemini 3.x checkpoints stream zero bytes when
            // thinkingConfig.includeThoughts is on. Once we observe that
            // for a given model, skip the field on subsequent calls for
            // the same model.
            if (!this._thinkingConfigBroken) this._thinkingConfigBroken = {};
            const skipThinking = !!this._thinkingConfigBroken[model];

            // Some checkpoints (e.g. gemini-3.5-flash at certain moments)
            // return empty SSE bodies even WITHOUT thinkingConfig. After
            // observing that for a model we go straight to non-streaming
            // (chatCompletion) — that endpoint works for these models.
            // We signal this by throwing a sentinel error that the agent's
            // streamChatCompletion catch block converts into a chatCompletion
            // call.
            if (!this._streamingBroken) this._streamingBroken = {};
            if (this._streamingBroken[model]) {
                throw new Error('GEMINI_STREAM_DISABLED: model "' + model + '" returned empty streams previously — using non-streaming path.');
            }

            // streamGenerateContent + alt=sse → clean Server-Sent Events with `data: {...}\n\n` framing
            const url = this.apiBase + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(this.cfg.apiKey);
            // CRITICAL: pass stream=true so _buildGenPayload drops responseMimeType.
            const payload = this._buildGenPayload(args, /* stream */ true);
            if (skipThinking && payload.generationConfig && payload.generationConfig.thinkingConfig) {
                delete payload.generationConfig.thinkingConfig;
            }
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
            // The extractor returns BOTH the final-output text and any
            // thought-summary parts. We keep them separate so the JSON
            // parser downstream only sees final-output text (thoughts would
            // confuse it), while the live UI block sees everything.
            //
            // Thought parts in the response have `thought: true`. Plain
            // output parts only have `text`. We emit thoughts wrapped in
            // a sentinel envelope (\x01THOUGHT_OPEN\x01 ... \x01THOUGHT_CLOSE\x01)
            // so the agent's stream callback can route them visually while
            // the parser strips them before JSON parsing.
            const extract = (obj) => {
                const parts = obj && obj.candidates && obj.candidates[0]
                    && obj.candidates[0].content && obj.candidates[0].content.parts || [];
                let s = '';
                for (const p of parts) {
                    if (!p || !p.text) continue;
                    if (p.thought) {
                        // Wrap thought text in an invisible marker pair so
                        // the chat-side parser can strip it before JSON.parse
                        // (see agent.js → strip-thoughts post-process).
                        s += '\x01T_OPEN\x01' + p.text + '\x01T_CLOSE\x01';
                    } else {
                        s += p.text;
                    }
                }
                return s;
            };
            const full = await consumeSSE(res, extract, onChunk, args.signal);
            const stripped = full.replace(/\x01T_OPEN\x01[\s\S]*?\x01T_CLOSE\x01/g, '').trim();
            if (stripped) {
                return { text: full, raw: { streamed: true } };
            }

            // Empty body — Gemini sometimes responds this way when
            // thinkingConfig.includeThoughts isn't accepted by the specific
            // model checkpoint. Auto-retry without thinkingConfig once and
            // remember the model so future calls skip the bad payload up
            // front.
            if (!skipThinking && payload.generationConfig && payload.generationConfig.thinkingConfig) {
                this._thinkingConfigBroken[model] = true;
                const retryPayload = JSON.parse(JSON.stringify(payload));
                delete retryPayload.generationConfig.thinkingConfig;
                const res2 = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                    body: JSON.stringify(retryPayload),
                    signal: args.signal
                });
                if (res2.ok) {
                    const full2 = await consumeSSE(res2, extract, onChunk, args.signal);
                    if (full2.trim()) {
                        return { text: full2, raw: { streamed: true, retriedWithoutThinking: true } };
                    }
                }
            }

            // Still empty after retry — the streaming endpoint is broken
            // for this checkpoint. Mark it so future calls skip streaming
            // immediately and signal the agent to fall back to
            // chatCompletion.
            this._streamingBroken[model] = true;
            throw new Error('GEMINI_STREAM_EMPTY: model "' + model + '" returned empty streams (with and without thinkingConfig). Falling back to non-streaming for this model from now on.');
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
            // JSON mode is incompatible with progressive streaming: when the
            // upstream provider sees response_format=json_object it buffers
            // the entire response server-side and emits it as one final
            // chunk. We only request strict JSON for non-streaming calls;
            // the streaming path relies on the system prompt to keep the
            // model emitting valid JSON.
            if (!stream && args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
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
    // OpenAI Provider (native chat completions + image generation)
    // =================================================================
    //
    // Supports:
    //   • LLM: /v1/chat/completions (sync + SSE streaming)
    //   • LLM listing: /v1/models — filter to chat-capable
    //   • Image: /v1/images/generations (gpt-image-1, DALL·E 3, DALL·E 2)
    //   • Image edits: /v1/images/edits (multipart; for inpainting with mask)
    //
    // The OpenAI chat-completions wire format is identical to OpenRouter's
    // (which mimics OpenAI). We reuse OpenRouterProvider.geminiToOpenAI for
    // history conversion to avoid duplication.
    class OpenAIProvider extends BaseProvider {
        get apiBase() {
            const base = (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
            return base;
        }

        _headers(extra) {
            const h = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.cfg.apiKey
            };
            if (this.cfg.org)     h['OpenAI-Organization'] = this.cfg.org;
            if (this.cfg.project) h['OpenAI-Project'] = this.cfg.project;
            return extra ? Object.assign(h, extra) : h;
        }

        async listLLMModels() {
            if (!this.cfg.apiKey) throw new Error('Missing OpenAI API key.');
            const url = this.apiBase + '/models';
            const data = await httpJSON(url, { method: 'GET', headers: this._headers() }, { timeoutMs: 30000, retries: 1 });
            const arr = (data.data || []).slice();
            // Filter: chat-capable models. OpenAI doesn't expose a capability
            // flag in /v1/models, so we infer from the id prefix family.
            const isChatModel = id => /^(gpt-|chatgpt-|o[1-9]|o-mini|gpt5|gpt-5|gpt-4)/i.test(id)
                                   && !/(embed|whisper|tts|moderation|davinci|babbage|audio|realtime|transcribe)/i.test(id);
            const isImageModel = id => /^(dall-e|gpt-image|gpt-5-image|image)/i.test(id);
            return arr
                .filter(m => isChatModel(m.id || ''))
                .map(m => ({
                    id: m.id,
                    name: m.id,
                    provider: 'openai',
                    contextLength: null,   // not exposed; UI will show "unknown"
                    description: m.owned_by ? ('owned_by ' + m.owned_by) : '',
                    features: {
                        vision: /^(gpt-4o|gpt-4-vision|gpt-5)/i.test(m.id || ''),
                        tools: /^(gpt-4|gpt-5|o[1-9])/i.test(m.id || ''),
                        json: true,
                        imageOutput: false
                    },
                    raw: m
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
        }

        async listImageModels() {
            if (!this.cfg.apiKey) {
                // Hardcoded fallback list — OpenAI's image catalog is small
                // and stable, so listing without a key still returns sensible
                // options in the UI picker.
                return [
                    { id: 'gpt-image-1', name: 'gpt-image-1 (newest, supports edits + vision-aware prompts)', provider: 'openai' },
                    { id: 'dall-e-3',    name: 'DALL·E 3 (legacy, 1024–1792 px)', provider: 'openai' },
                    { id: 'dall-e-2',    name: 'DALL·E 2 (legacy, supports edits + variations)', provider: 'openai' }
                ];
            }
            try {
                const url = this.apiBase + '/models';
                const data = await httpJSON(url, { method: 'GET', headers: this._headers() }, { timeoutMs: 30000, retries: 1 });
                const arr = (data.data || []).filter(m => /^(dall-e|gpt-image)/i.test(m.id || ''));
                if (arr.length === 0) {
                    return [
                        { id: 'gpt-image-1', name: 'gpt-image-1', provider: 'openai' },
                        { id: 'dall-e-3',    name: 'DALL·E 3',    provider: 'openai' },
                        { id: 'dall-e-2',    name: 'DALL·E 2',    provider: 'openai' }
                    ];
                }
                return arr.map(m => ({ id: m.id, name: m.id, provider: 'openai', raw: m }));
            } catch (_) {
                return [
                    { id: 'gpt-image-1', name: 'gpt-image-1', provider: 'openai' },
                    { id: 'dall-e-3',    name: 'DALL·E 3',    provider: 'openai' }
                ];
            }
        }

        _buildOAIPayload(args, stream) {
            const model = args.model || 'gpt-4o';
            // o-series reasoning models reject `temperature` and use
            // `max_completion_tokens` instead of `max_tokens`. Detect by id.
            const isReasoning = /^o[1-9]|^o-mini|^gpt-5/i.test(model);
            const cfg = args.generationConfig || {};
            const payload = {
                model: model,
                messages: OpenRouterProvider.geminiToOpenAI(args.systemInstruction, args.messages)
            };
            if (isReasoning) {
                if (cfg.maxOutputTokens) payload.max_completion_tokens = cfg.maxOutputTokens;
            } else {
                payload.temperature = (cfg.temperature != null) ? cfg.temperature : 0.2;
                payload.max_tokens  = cfg.maxOutputTokens || 16384;
            }
            // Streaming + JSON mode = the upstream buffers the whole response
            // and emits it at the end (since partial JSON isn't valid). Skip
            // the JSON-mode hint on stream calls so tokens flow as generated;
            // the system prompt still instructs the model to emit JSON.
            if (!stream && cfg.responseMimeType === 'application/json') {
                payload.response_format = { type: 'json_object' };
            }
            if (stream) payload.stream = true;
            return payload;
        }

        async chatCompletion(args) {
            if (!this.cfg.apiKey) throw new Error('Missing OpenAI API key.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildOAIPayload(args, false);
            const data = await httpJSON(url, {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 180000, signal: args.signal, retries: 1 });
            if (!data.choices || !data.choices[0]) {
                throw new Error('OpenAI: empty response. ' + (data.error ? JSON.stringify(data.error) : ''));
            }
            const msg = data.choices[0].message || {};
            const text = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
            return { text: text, raw: data };
        }

        async streamChatCompletion(args, onChunk) {
            if (!this.cfg.apiKey) throw new Error('Missing OpenAI API key.');
            const url = this.apiBase + '/chat/completions';
            const payload = this._buildOAIPayload(args, true);
            const res = await fetch(url, {
                method: 'POST',
                headers: this._headers({ 'Accept': 'text/event-stream' }),
                body: JSON.stringify(payload),
                signal: args.signal
            });
            if (!res.ok) {
                const errTxt = await res.text();
                throw new Error('OpenAI stream HTTP ' + res.status + ': ' + errTxt.substring(0, 300));
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
            if (!this.cfg.apiKey) throw new Error('Missing OpenAI API key.');
            const model = args.model || 'gpt-image-1';
            // gpt-image-1 returns base64 by default; DALL·E variants return URL
            // unless response_format is set to b64_json.
            const isGptImage = /^gpt-image/i.test(model);
            // Endpoint selection: edits when reference image is provided AND model supports it
            const hasRef = !!(args.referenceImages && args.referenceImages.length);
            if (hasRef && (isGptImage || /dall-e-2/i.test(model))) {
                return await this._generateImageEdit(args);
            }
            const url = this.apiBase + '/images/generations';
            const payload = {
                model: model,
                prompt: args.prompt,
                n: 1,
                size: args.size || (isGptImage ? '1024x1024' : '1024x1024')
            };
            if (!isGptImage) payload.response_format = 'b64_json';
            // gpt-image-1 specific knobs
            if (isGptImage) {
                if (args.quality) payload.quality = args.quality;
                if (args.background) payload.background = args.background;
                if (args.outputFormat) payload.output_format = args.outputFormat;
            }
            const data = await httpJSON(url, {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(payload),
                signal: args.signal
            }, { timeoutMs: 240000, signal: args.signal, retries: 1 });
            const first = data.data && data.data[0];
            if (!first) throw new Error('OpenAI Image: no image in response.');
            if (first.b64_json) {
                return { mimeType: 'image/png', data: first.b64_json };
            }
            if (first.url) {
                // Fetch the URL and convert to base64 — keeps the rest of the
                // pipeline uniform (asset saving expects base64).
                const r = await fetch(first.url);
                const buf = await r.arrayBuffer();
                const b64 = arrayBufferToBase64(buf);
                const mt = r.headers.get('content-type') || 'image/png';
                return { mimeType: mt, data: b64 };
            }
            throw new Error('OpenAI Image: response missing b64_json and url.');
        }

        async _generateImageEdit(args) {
            // /v1/images/edits is multipart/form-data. fetch() supports FormData
            // natively in modern Chromium (CEP 11 ships Chromium 88+).
            const url = this.apiBase + '/images/edits';
            const form = new FormData();
            form.append('model', args.model || 'gpt-image-1');
            form.append('prompt', args.prompt);
            form.append('n', '1');
            form.append('size', args.size || '1024x1024');
            // Attach first reference image as the base
            const ref = args.referenceImages[0];
            const blob = base64ToBlob(ref.data, ref.mimeType || 'image/png');
            form.append('image', blob, 'reference.png');
            // Optional mask (for inpainting). Convention: second referenceImage
            // is treated as mask when args.useMask === true.
            if (args.useMask && args.referenceImages[1]) {
                const m = args.referenceImages[1];
                const mblob = base64ToBlob(m.data, m.mimeType || 'image/png');
                form.append('mask', mblob, 'mask.png');
            }
            const headers = { 'Authorization': 'Bearer ' + this.cfg.apiKey };
            if (this.cfg.org)     headers['OpenAI-Organization'] = this.cfg.org;
            if (this.cfg.project) headers['OpenAI-Project'] = this.cfg.project;
            const res = await fetch(url, { method: 'POST', headers: headers, body: form, signal: args.signal });
            if (!res.ok) {
                const t = await res.text();
                throw new Error('OpenAI Image Edit HTTP ' + res.status + ': ' + t.substring(0, 300));
            }
            const data = await res.json();
            const first = data.data && data.data[0];
            if (!first) throw new Error('OpenAI Image Edit: empty response.');
            if (first.b64_json) return { mimeType: 'image/png', data: first.b64_json };
            if (first.url) {
                const r = await fetch(first.url);
                const buf = await r.arrayBuffer();
                return { mimeType: r.headers.get('content-type') || 'image/png', data: arrayBufferToBase64(buf) };
            }
            throw new Error('OpenAI Image Edit: missing b64_json and url.');
        }
    }

    // Helpers used by the OpenAI image edit path
    function arrayBufferToBase64(buf) {
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }
    function base64ToBlob(b64, mime) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || 'application/octet-stream' });
    }

    // =================================================================
    // ComfyUI Provider (local image generation via /prompt + /history)
    // =================================================================
    //
    // ComfyUI is a node-graph image generator (FLUX, SDXL, SD3, …) that
    // runs locally. The plugin posts a workflow JSON to /prompt and polls
    // /history/{prompt_id} until the queue resolves, then downloads the
    // output PNG via /view.
    //
    // Workflow template convention: any string field containing the literal
    // placeholders below will be replaced before submitting:
    //   __POSITIVE_PROMPT__   → args.prompt
    //   __NEGATIVE_PROMPT__   → args.negativePrompt || ''
    //   __SEED__              → random 32-bit integer (or args.seed if given)
    //   __WIDTH__             → args.width  || 1024
    //   __HEIGHT__            → args.height || 1024
    //
    // Out of the box we ship a minimal SDXL workflow that works if the
    // user has sd_xl_base_1.0.safetensors in their /models/checkpoints
    // folder. Users with custom setups will paste their own JSON.
    class ComfyUIProvider extends BaseProvider {
        get apiBase() {
            const base = (this.cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
            return base;
        }

        async listLLMModels() {
            throw new Error('ComfyUI is an image-only provider — pick a different provider for LLM tasks.');
        }
        async chatCompletion() {
            throw new Error('ComfyUI is an image-only provider.');
        }
        async streamChatCompletion() {
            throw new Error('ComfyUI is an image-only provider.');
        }

        async listImageModels() {
            // Surface installed checkpoints so the UI can show a sensible picker.
            // ComfyUI /object_info exposes the schema for every node — we walk
            // CheckpointLoaderSimple → required → ckpt_name → enum values.
            try {
                const url = this.apiBase + '/object_info/CheckpointLoaderSimple';
                const data = await httpJSON(url, { method: 'GET' }, { timeoutMs: 8000, retries: 0 });
                const info = data && data.CheckpointLoaderSimple;
                const ckpts = (info && info.input && info.input.required && info.input.required.ckpt_name) || [];
                const names = Array.isArray(ckpts[0]) ? ckpts[0] : [];
                return names.map(name => ({ id: name, name: name, provider: 'comfyui' }));
            } catch (e) {
                throw new Error('Could not reach ComfyUI at ' + this.apiBase + ' — start ComfyUI (python main.py --listen) first. Detail: ' + e.message);
            }
        }

        // Replace placeholder tokens inside any string fields of the workflow.
        _normalizeWorkflow(rawJson, args) {
            const seed = (args.seed != null) ? args.seed : Math.floor(Math.random() * 2_147_483_647);
            const subst = {
                '__POSITIVE_PROMPT__': args.prompt || '',
                '__NEGATIVE_PROMPT__': args.negativePrompt || '',
                '__SEED__':            String(seed),
                '__WIDTH__':           String(args.width  || 1024),
                '__HEIGHT__':          String(args.height || 1024)
            };
            let workflowStr = (typeof rawJson === 'string') ? rawJson : JSON.stringify(rawJson);
            Object.keys(subst).forEach(k => {
                workflowStr = workflowStr.split(k).join(subst[k]);
            });
            let workflow;
            try {
                workflow = JSON.parse(workflowStr);
            } catch (e) {
                throw new Error('ComfyUI workflow JSON is invalid after substitution: ' + e.message);
            }
            return { workflow, seed };
        }

        // Minimal SDXL workflow as a sensible default. Users override via cfg.workflow.
        _defaultWorkflow() {
            return {
                "3": {
                    "inputs": {
                        "seed": "__SEED__",
                        "steps": 25,
                        "cfg": 7.0,
                        "sampler_name": "euler",
                        "scheduler": "normal",
                        "denoise": 1.0,
                        "model":   ["4", 0],
                        "positive":["6", 0],
                        "negative":["7", 0],
                        "latent_image":["5", 0]
                    },
                    "class_type": "KSampler"
                },
                "4": { "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" }, "class_type": "CheckpointLoaderSimple" },
                "5": { "inputs": { "width": "__WIDTH__", "height": "__HEIGHT__", "batch_size": 1 }, "class_type": "EmptyLatentImage" },
                "6": { "inputs": { "text": "__POSITIVE_PROMPT__", "clip": ["4", 1] }, "class_type": "CLIPTextEncode" },
                "7": { "inputs": { "text": "__NEGATIVE_PROMPT__", "clip": ["4", 1] }, "class_type": "CLIPTextEncode" },
                "8": { "inputs": { "samples": ["3", 0], "vae": ["4", 2] }, "class_type": "VAEDecode" },
                "9": { "inputs": { "filename_prefix": "AfterALL_", "images": ["8", 0] }, "class_type": "SaveImage" }
            };
        }

        async generateImage(args) {
            const base = this.apiBase;
            // 1. Build the workflow
            let raw;
            if (this.cfg.workflow && this.cfg.workflow.length) {
                raw = this.cfg.workflow;
            } else {
                raw = this._defaultWorkflow();
            }
            // Coerce numeric placeholders (seed/width/height) after JSON.parse —
            // ComfyUI expects numbers, not strings, so we do a second pass.
            const { workflow } = this._normalizeWorkflow(raw, args);
            this._coerceNumericNodes(workflow);

            // 2. Queue the prompt
            const clientId = this.cfg.clientId || 'afterall';
            const queueRes = await httpJSON(base + '/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow, client_id: clientId }),
                signal: args.signal
            }, { timeoutMs: 15000, retries: 0 });
            const promptId = queueRes && queueRes.prompt_id;
            if (!promptId) {
                const errs = queueRes && (queueRes.node_errors || queueRes.error);
                throw new Error('ComfyUI did not return prompt_id. Workflow error: ' + JSON.stringify(errs || queueRes).substring(0, 300));
            }

            // 3. Poll /history/{prompt_id} until the queue finishes
            const start = Date.now();
            const timeoutMs = args.timeoutMs || 240000; // 4 minutes default for big workflows
            let history = null;
            while (true) {
                if (args.signal && args.signal.aborted) {
                    throw new Error('ComfyUI generation aborted.');
                }
                if (Date.now() - start > timeoutMs) {
                    throw new Error('ComfyUI generation timed out after ' + Math.round(timeoutMs / 1000) + 's.');
                }
                await new Promise(r => setTimeout(r, 700));
                try {
                    const hRes = await httpJSON(base + '/history/' + encodeURIComponent(promptId),
                        { method: 'GET' }, { timeoutMs: 8000, retries: 0 });
                    if (hRes && hRes[promptId]) {
                        const status = hRes[promptId].status || {};
                        if (status.completed === true || (hRes[promptId].outputs && Object.keys(hRes[promptId].outputs).length > 0)) {
                            history = hRes[promptId];
                            break;
                        }
                        if (status.status_str === 'error') {
                            const msgs = (status.messages || []).map(m => JSON.stringify(m)).join(' · ');
                            throw new Error('ComfyUI workflow error: ' + msgs.substring(0, 400));
                        }
                    }
                } catch (e) {
                    // transient polling errors are fine; rethrow user aborts
                    if (e.name === 'AbortError') throw e;
                }
            }

            // 4. Find the first image output across all nodes
            const outputs = history.outputs || {};
            let firstImage = null;
            Object.keys(outputs).forEach(nodeId => {
                if (firstImage) return;
                const images = outputs[nodeId].images || [];
                if (images.length > 0) firstImage = images[0];
            });
            if (!firstImage) throw new Error('ComfyUI completed but no image output found.');

            // 5. Fetch the PNG via /view
            const params = new URLSearchParams();
            params.set('filename',  firstImage.filename);
            if (firstImage.subfolder) params.set('subfolder', firstImage.subfolder);
            params.set('type',      firstImage.type || 'output');
            const viewUrl = base + '/view?' + params.toString();
            const imgRes = await fetch(viewUrl, { signal: args.signal });
            if (!imgRes.ok) throw new Error('ComfyUI /view HTTP ' + imgRes.status);
            const buf = await imgRes.arrayBuffer();
            return {
                mimeType: imgRes.headers.get('content-type') || 'image/png',
                data: arrayBufferToBase64(buf)
            };
        }

        // ComfyUI accepts INT/FLOAT inputs as actual numbers. After string
        // substitution our seed/width/height fields are strings — coerce
        // anything that looks like a clean integer/decimal back to a number.
        _coerceNumericNodes(workflow) {
            Object.keys(workflow).forEach(nodeId => {
                const node = workflow[nodeId];
                if (!node || !node.inputs) return;
                Object.keys(node.inputs).forEach(field => {
                    const v = node.inputs[field];
                    if (typeof v !== 'string') return;
                    if (/^-?\d+$/.test(v))           node.inputs[field] = parseInt(v, 10);
                    else if (/^-?\d*\.\d+$/.test(v)) node.inputs[field] = parseFloat(v);
                });
            });
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
            // JSON mode + streaming buffers the response server-side; drop the
            // hint on stream calls. LM Studio's local server respects the
            // OpenAI contract, so the same caveat applies.
            if (!stream && args.generationConfig && args.generationConfig.responseMimeType === 'application/json') {
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
        OpenAIProvider,
        ComfyUIProvider,
        LMStudioProvider,
        // Factory
        create(name, cfg) {
            switch ((name || 'gemini').toLowerCase()) {
                case 'gemini':     return new GeminiProvider(cfg || {});
                case 'openrouter': return new OpenRouterProvider(cfg || {});
                case 'openai':     return new OpenAIProvider(cfg || {});
                case 'comfyui':    return new ComfyUIProvider(cfg || {});
                case 'lmstudio':   return new LMStudioProvider(cfg || {});
                default: throw new Error('Unknown provider: ' + name);
            }
        },
        // Expose http helper for advanced use
        httpJSON: httpJSON
    };

    global.AfterAllProviders = Providers;
})(typeof window !== 'undefined' ? window : globalThis);
