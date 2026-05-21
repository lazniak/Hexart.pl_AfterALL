// =====================================================================
// HEXART.PL/AfterALL - Orchestration Subsystem
// =====================================================================
// Three modules in one file:
//   1. AssetTracker  - snapshots project state before task, classifies items
//                      as "pre-existing user content" vs. "agent-created"
//   2. PermissionManager - handles ask/allow/deny/remember for sensitive ops
//   3. PipelineUI - rich in-chat visualization of sequential + parallel work
// =====================================================================

(function (global) {
    'use strict';

    // =================================================================
    // ASSET TRACKER
    // =================================================================
    // Tracks pre-existing items at task start. Any item NOT in the snapshot
    // and matching agent-created prefixes is considered "transient" (safe to
    // delete). Anything from the snapshot is "user content" (protected).
    class AssetTracker {
        constructor() {
            this.snapshot = null;          // captured at task start
            this.taskStartTime = 0;
            this.transientPrefixes = [
                'aisist_gen_', 'aisist_img_', 'aisist_tts_', 'aisist_vid_',
                'aisist_music_', 'aisist_edit_', 'aisist_svg_'
            ];
        }
        async snapshotProject(csInterface) {
            this.taskStartTime = Date.now();
            return new Promise((resolve) => {
                try {
                    csInterface.evalScript('getAssetSnapshot()', (res) => {
                        try {
                            this.snapshot = JSON.parse(res || '{}');
                            resolve(this.snapshot);
                        } catch (e) {
                            this.snapshot = { items: [], layers: {}, file: null };
                            resolve(this.snapshot);
                        }
                    });
                } catch (e) {
                    this.snapshot = { items: [], layers: {}, file: null };
                    resolve(this.snapshot);
                }
            });
        }
        // Classify a target name as 'protected', 'transient', or 'unknown'
        classify(target) {
            if (!target) return 'unknown';
            const name = String(target);
            // Check transient prefixes first - these are agent-created and safe
            for (const p of this.transientPrefixes) {
                if (name.indexOf(p) !== -1) return 'transient';
            }
            // Check against snapshot
            if (this.snapshot && this.snapshot.items) {
                if (this.snapshot.items.indexOf(name) !== -1) return 'protected';
                // Also check layers
                if (this.snapshot.layers) {
                    for (const compName in this.snapshot.layers) {
                        if (this.snapshot.layers[compName].indexOf(name) !== -1) return 'protected';
                    }
                }
            }
            return 'unknown';
        }
        // Snapshot summary for system prompt context
        summary() {
            if (!this.snapshot) return '(no snapshot captured)';
            const items = (this.snapshot.items || []).length;
            const comps = Object.keys(this.snapshot.layers || {}).length;
            return `Project snapshot at task start: ${items} items, ${comps} comps (these are PROTECTED user content - do not delete)`;
        }
    }

    // =================================================================
    // PERMISSION MANAGER
    // =================================================================
    // Operation types:
    //   delete_layer, delete_project_item, overwrite_user_file,
    //   modify_protected, run_long_python, install_python_packages,
    //   external_http_call, file_system_write, custom
    //
    // Decision modes: 'once' | 'always' | 'always-this-type' | 'never' | 'session'
    // Time-bound: 'session' decisions clear on session restart
    class PermissionManager {
        constructor(storage) {
            this.storage = storage;
            this.rules = this._loadRules();
            this.sessionAllowances = {}; // { 'op:target': expiryTimestamp }
        }
        _loadRules() {
            try {
                const raw = this.storage.getItem('hexart_permission_rules');
                const parsed = raw ? JSON.parse(raw) : null;
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) { return []; }
        }
        _saveRules() {
            try { this.storage.setItem('hexart_permission_rules', JSON.stringify(this.rules)); } catch (e) { /* ignore */ }
        }
        // Returns: 'allow' | 'deny' | 'ask'
        check(operation, target) {
            const t = String(target || '*');
            // Check session allowances first
            const key = operation + ':' + t;
            const exp = this.sessionAllowances[key];
            if (exp && exp > Date.now()) return 'allow';

            // Check stored rules (most specific first)
            for (const r of this.rules) {
                if (r.expires_at && r.expires_at < Date.now()) continue; // expired
                if (r.operation === operation) {
                    if (r.target === t || r.target === '*' || (r.targetPattern && new RegExp(r.targetPattern).test(t))) {
                        return r.decision; // 'allow' | 'deny'
                    }
                }
            }
            return 'ask';
        }
        // Grant a decision. modes:
        //   'once' - session only, this exact target
        //   'session' - all targets of this op for current session
        //   'always-target' - persist, this target
        //   'always-type' - persist, all targets of this operation type
        //   'temporary' - persist with expiry timestamp
        grant(operation, target, decision, mode, durationMs) {
            const t = String(target || '*');
            const key = operation + ':' + t;
            if (mode === 'once') {
                // Session-scope, single use (allow once means we should still consume the allowance)
                this.sessionAllowances[key] = Date.now() + (durationMs || 5 * 60 * 1000); // 5 min default
                return;
            }
            if (mode === 'session') {
                this.sessionAllowances[operation + ':*'] = Date.now() + (24 * 60 * 60 * 1000); // 24h cap
                return;
            }
            const rule = {
                operation: operation,
                target: (mode === 'always-type') ? '*' : t,
                decision: decision,
                created_at: Date.now()
            };
            if (mode === 'temporary' && durationMs) {
                rule.expires_at = Date.now() + durationMs;
            }
            // Replace older rules for same op+target
            this.rules = this.rules.filter(r => !(r.operation === operation && r.target === rule.target));
            this.rules.unshift(rule);
            this._saveRules();
        }
        revoke(operation, target) {
            this.rules = this.rules.filter(r => !(r.operation === operation && r.target === (target || '*')));
            const key = operation + ':' + (target || '*');
            delete this.sessionAllowances[key];
            this._saveRules();
        }
        list() { return this.rules.slice(); }
        clearAll() { this.rules = []; this._saveRules(); this.sessionAllowances = {}; }
    }

    // =================================================================
    // PIPELINE UI
    // =================================================================
    // In-chat rendering of multi-step processes with live state updates.
    // Each Pipeline manages one card. Steps can be sequential or parallel groups.
    class Pipeline {
        constructor(container, opts) {
            this.container = container;          // DOM node to append the card to
            this.opts = opts || {};
            this.steps = [];                     // [{ id, label, status, kind, parallelGroup, startTime, endTime, progress, message }]
            this.title = opts.title || 'Pipeline';
            this.subtitle = opts.subtitle || '';
            this._el = null;
            this._buildCard();
            this._renderTick = null;
        }
        _buildCard() {
            const card = document.createElement('div');
            card.className = 'pipeline-card';
            card.innerHTML = `
                <div class="pipeline-head">
                    <div class="pipeline-icon">${this.opts.icon || '⚙'}</div>
                    <div class="pipeline-titles">
                        <div class="pipeline-title"></div>
                        <div class="pipeline-subtitle"></div>
                    </div>
                    <div class="pipeline-stats">
                        <span class="pipeline-elapsed">0s</span>
                    </div>
                </div>
                <div class="pipeline-body"></div>
                <div class="pipeline-footer">
                    <span class="pipeline-summary"></span>
                </div>
            `;
            this._el = card;
            this._el.querySelector('.pipeline-title').textContent = this.title;
            this._el.querySelector('.pipeline-subtitle').textContent = this.subtitle;
            this.container.appendChild(card);
            this._startTime = Date.now();
            // Live elapsed clock
            this._renderTick = setInterval(() => this._updateElapsed(), 500);
        }
        _updateElapsed() {
            const sec = Math.floor((Date.now() - this._startTime) / 1000);
            const el = this._el.querySelector('.pipeline-elapsed');
            if (el) el.textContent = (sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's');
        }
        setTitle(t) { this.title = t; if (this._el) this._el.querySelector('.pipeline-title').textContent = t; }
        setSubtitle(s) { this.subtitle = s; if (this._el) this._el.querySelector('.pipeline-subtitle').textContent = s; }
        // Add a step. parallelGroup: undefined for sequential, or a string id for parallel siblings.
        addStep(step) {
            const s = Object.assign({
                id: 'step_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
                label: 'Step', kind: 'task', status: 'pending', parallelGroup: null,
                startTime: null, endTime: null, progress: null, message: '', icon: null
            }, step);
            this.steps.push(s);
            this._render();
            return s.id;
        }
        updateStep(id, patch) {
            const idx = this.steps.findIndex(s => s.id === id);
            if (idx === -1) return;
            const s = this.steps[idx];
            if (patch.status === 'running' && !s.startTime) s.startTime = Date.now();
            if ((patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') && !s.endTime) s.endTime = Date.now();
            Object.assign(s, patch);
            this._render();
        }
        setStepProgress(id, progress, message) {
            this.updateStep(id, { progress: progress, message: message });
        }
        _statusIcon(status) {
            switch (status) {
                case 'pending':   return '<span class="ps-icon ps-pending">⋯</span>';
                case 'running':   return '<span class="ps-icon ps-running"><span class="ps-spin"></span></span>';
                case 'done':      return '<span class="ps-icon ps-done">✓</span>';
                case 'failed':    return '<span class="ps-icon ps-failed">✕</span>';
                case 'skipped':   return '<span class="ps-icon ps-skipped">⊘</span>';
                case 'awaiting':  return '<span class="ps-icon ps-awaiting">?</span>';
                default:          return '<span class="ps-icon">·</span>';
            }
        }
        _kindIcon(kind) {
            const map = { image: '🖼', tts: '🎙', music: '🎵', video: '🎬', svg: '✦', python: '🐍',
                          extendscript: '⌘', stt: '📝', research: '🔎', planning: '🧠',
                          edit: '✂', approval: '⚖' };
            return map[kind] || '·';
        }
        _render() {
            const body = this._el.querySelector('.pipeline-body');
            body.innerHTML = '';
            // Group steps by parallelGroup, preserving order
            let i = 0;
            while (i < this.steps.length) {
                const s = this.steps[i];
                if (!s.parallelGroup) {
                    body.appendChild(this._renderStep(s));
                    i++;
                } else {
                    // Collect contiguous siblings with same parallelGroup
                    const group = [];
                    while (i < this.steps.length && this.steps[i].parallelGroup === s.parallelGroup) {
                        group.push(this.steps[i]); i++;
                    }
                    body.appendChild(this._renderParallelGroup(group));
                }
            }
            // Update footer summary
            const done = this.steps.filter(s => s.status === 'done').length;
            const failed = this.steps.filter(s => s.status === 'failed').length;
            const total = this.steps.length;
            const txt = done + ' / ' + total + ' complete' + (failed > 0 ? ' · ' + failed + ' failed' : '');
            this._el.querySelector('.pipeline-summary').textContent = txt;
        }
        _renderStep(s) {
            const row = document.createElement('div');
            row.className = 'ps-step ps-step-' + s.status;
            const kindIc = s.icon || this._kindIcon(s.kind);
            const dur = s.startTime && s.endTime ? ((s.endTime - s.startTime) / 1000).toFixed(1) + 's' : (s.startTime ? 'live' : '');
            let progressBar = '';
            if (s.status === 'running' && typeof s.progress === 'number') {
                progressBar = '<div class="ps-progress"><div class="ps-progress-fill" style="width:' + Math.min(100, Math.max(0, s.progress)) + '%"></div></div>';
            }
            row.innerHTML = `
                ${this._statusIcon(s.status)}
                <span class="ps-kind">${kindIc}</span>
                <div class="ps-meta">
                    <div class="ps-label">${escapeHTML(s.label)}</div>
                    ${s.message ? '<div class="ps-msg">' + escapeHTML(s.message) + '</div>' : ''}
                    ${progressBar}
                </div>
                <span class="ps-time">${dur}</span>
            `;
            return row;
        }
        _renderParallelGroup(group) {
            const wrap = document.createElement('div');
            wrap.className = 'ps-parallel';
            const head = document.createElement('div');
            head.className = 'ps-parallel-head';
            const running = group.filter(s => s.status === 'running').length;
            const done = group.filter(s => s.status === 'done').length;
            head.innerHTML = `
                <span class="ps-parallel-badge">RÓWNOLEGLE</span>
                <span class="ps-parallel-stats">${done}/${group.length}${running ? ' · ' + running + ' aktywnych' : ''}</span>
            `;
            wrap.appendChild(head);
            const list = document.createElement('div');
            list.className = 'ps-parallel-list';
            group.forEach(s => list.appendChild(this._renderStep(s)));
            wrap.appendChild(list);
            return wrap;
        }
        finish(summary) {
            if (this._renderTick) { clearInterval(this._renderTick); this._renderTick = null; }
            const total = this.steps.length;
            const done = this.steps.filter(s => s.status === 'done').length;
            const failed = this.steps.filter(s => s.status === 'failed').length;
            const elapsedSec = Math.round((Date.now() - this._startTime) / 1000);
            const summaryText = summary
                || (failed === 0 ? '✓ Wszystko gotowe — ' + done + '/' + total + ' kroków · ' + elapsedSec + 's'
                                 : '⚠ Zakończono z błędami — ' + done + ' OK, ' + failed + ' fail, ' + elapsedSec + 's');
            this._el.classList.add('pipeline-finished');
            if (failed > 0) this._el.classList.add('pipeline-has-errors');
            const sumEl = this._el.querySelector('.pipeline-summary');
            if (sumEl) sumEl.textContent = summaryText;
            this._updateElapsed();
        }
        destroy() {
            if (this._renderTick) { clearInterval(this._renderTick); this._renderTick = null; }
        }
    }

    function escapeHTML(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // =================================================================
    // Export
    // =================================================================
    global.AfterAllOrchestration = {
        AssetTracker,
        PermissionManager,
        Pipeline
    };
})(typeof window !== 'undefined' ? window : globalThis);
