// =====================================================================
// HEXART.PL/AfterALL MCP — Tool definitions
// =====================================================================
// Every tool maps onto a POST endpoint exposed by the in-AE bridge.
// =====================================================================

/**
 * Tool list — schema follows MCP / JSON-Schema conventions.
 * Each tool: { name, description, inputSchema, bridgePath }
 */
export const tools = [
    {
        name: 'afterall_status',
        description: 'Check whether After Effects is reachable and return basic info about the active project (name, active comp, AE version, plugin version). Useful as a connectivity check before issuing other commands.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/status'
    },
    {
        name: 'afterall_get_project_context',
        description: 'Deep scan of the current After Effects project — returns full JSON with all comps, folders, footage items, the active composition with layers, layer types, effects, expressions, text content. This is the same context the agent uses to understand the project.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/get_project_context'
    },
    {
        name: 'afterall_send_prompt',
        description: 'Send a natural-language prompt to the AfterALL AI agent. The agent will plan, generate assets (images/TTS/music/video/SFX), execute ExtendScript inside After Effects, and self-correct on errors. This is the primary way to drive the plugin — equivalent to typing in the in-AE chat. Returns the final agent response with status, plan, and any generated asset paths. Blocking call — may take 30s-15min depending on complexity.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Natural-language instruction for the agent (in any language — agent auto-detects).' },
                attachments: {
                    type: 'array',
                    description: 'Optional reference files (images, audio, video, PDF) as absolute paths or base64 data URIs.',
                    items: { type: 'string' }
                },
                wait_for_completion: { type: 'boolean', default: true, description: 'If false, returns immediately with a task_id you can poll via afterall_get_task_status.' }
            },
            required: ['prompt'],
            additionalProperties: false
        },
        bridgePath: '/send_prompt'
    },
    {
        name: 'afterall_get_task_status',
        description: 'Poll the status of an async task started with wait_for_completion=false. Returns current_plan, last message, progress percentage, and final result when done.',
        inputSchema: {
            type: 'object',
            properties: { task_id: { type: 'string' } },
            required: ['task_id'],
            additionalProperties: false
        },
        bridgePath: '/get_task_status'
    },
    {
        name: 'afterall_execute_extendscript',
        description: 'Run raw ExtendScript code directly inside After Effects (bypassing the agent). Use for surgical edits when you already know exactly what to do. The plugin\'s wrapper handles UndoGroup. Returns the eval result or an error with line number.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'ExtendScript source. Do NOT include app.beginUndoGroup/endUndoGroup — wrapper handles them.' }
            },
            required: ['code'],
            additionalProperties: false
        },
        bridgePath: '/execute_extendscript'
    },
    {
        name: 'afterall_generate_image',
        description: 'Generate an image with the configured image provider (Gemini Nano Banana or OpenRouter image-capable model) and import it into the active composition as a layer. Returns the file path of the generated image.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Detailed image description (recommended: 500+ chars with style, camera, lighting, mood).' },
                reference_images: {
                    type: 'array',
                    description: 'Optional reference images as absolute file paths (for style transfer / image editing).',
                    items: { type: 'string' }
                }
            },
            required: ['prompt'],
            additionalProperties: false
        },
        bridgePath: '/generate_image'
    },
    {
        name: 'afterall_generate_tts',
        description: 'Generate a voiceover (TTS) with the configured provider (Gemini or ElevenLabs) and import the audio file into the active composition. Supports gender prefixes "Male:" / "Female:" to control voice. Returns the file path and duration.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to speak. Prefix with "Male:" or "Female:" to pick gender, or with a specific voice name.' }
            },
            required: ['text'],
            additionalProperties: false
        },
        bridgePath: '/generate_tts'
    },
    {
        name: 'afterall_generate_music',
        description: 'Compose a music track with the configured provider (Gemini Lyria 3 Pro instrumental or ElevenLabs Eleven Music with optional vocals). Automatically matches the duration of the last generated TTS if available. Returns the file path.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Music description (genre, tempo, mood, instruments, vocals).' },
                duration_seconds: { type: 'number', description: 'Optional. 10-300 for Eleven Music. Lyria auto-matches TTS.' },
                force_instrumental: { type: 'boolean', description: 'Eleven Music only — skip vocals.' }
            },
            required: ['prompt'],
            additionalProperties: false
        },
        bridgePath: '/generate_music'
    },
    {
        name: 'afterall_generate_sfx',
        description: 'Generate a sound effect (0.5-22s) via ElevenLabs Text-to-Sound-Effects. Ideal for whooshes, impacts, ambient loops, foley, UI sounds, transitions, glitches, magic, atmospheres.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'SFX description.' },
                duration_seconds: { type: 'number', description: '0.5-22, omit for auto.' },
                prompt_influence: { type: 'number', description: '0-1, default 0.3. Higher = more literal interpretation.' },
                loop: { type: 'boolean', description: 'Create a seamlessly looping sound.' }
            },
            required: ['prompt'],
            additionalProperties: false
        },
        bridgePath: '/generate_sfx'
    },
    {
        name: 'afterall_generate_video',
        description: 'Generate a short video (3-10s, image-to-video) via Replicate xAI Grok Imagine Video. Requires a source image (path or "last_image" reference). Imports the resulting MP4 into the composition.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Motion description (camera moves, atmospheric effects). DO NOT re-describe the scene already in the source image.' },
                source_image: { type: 'string', description: 'Absolute path to source image, OR "last_image" / "last_image_N" for a recently generated asset.' },
                duration: { type: 'integer', enum: [3, 5, 8, 10], default: 5 },
                aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', 'auto'], default: '16:9' }
            },
            required: ['prompt'],
            additionalProperties: false
        },
        bridgePath: '/generate_video'
    },
    {
        name: 'afterall_transcribe_audio',
        description: 'Transcribe an audio file to text with word-level timestamps using ElevenLabs Scribe v2. Returns JSON with words array (text, start, end), language, full text.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Absolute path to audio file, OR "last_audio" to use the most recently generated TTS.' },
                language_code: { type: 'string', description: 'Optional ISO 639-3 code (e.g. "pol", "eng"). Auto-detected if omitted.' }
            },
            required: ['source'],
            additionalProperties: false
        },
        bridgePath: '/transcribe_audio'
    },
    {
        name: 'afterall_run_python_task',
        description: 'Run a Python task in a managed virtual environment. The plugin creates/reuses the named venv, installs requested packages, clones git repos, then runs your script. Supports background processes (e.g. ComfyUI server).',
        inputSchema: {
            type: 'object',
            properties: {
                env: { type: 'string', description: 'venv name (creates if missing). Default "default".' },
                packages: { type: 'array', items: { type: 'string' }, description: 'pip packages to install.' },
                git_repos: { type: 'array', items: { type: 'string' }, description: 'GitHub URLs to clone.' },
                script: { type: 'string', description: 'Python source to run.' },
                command: { type: 'string', description: 'Optional shell command instead of script.' },
                background: { type: 'boolean', description: 'If true, runs as detached background process.' },
                background_name: { type: 'string', description: 'Name to dedupe background processes.' },
                ready_keyword: { type: 'string', description: 'Text in stdout that signals "ready" for background processes.' }
            },
            additionalProperties: false
        },
        bridgePath: '/run_python_task'
    },
    {
        name: 'afterall_get_screenshot',
        description: 'Capture a PNG screenshot of the currently active composition at the current time. Returns base64-encoded image data + MIME type. Useful for Vision-based verification.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/get_screenshot'
    },
    {
        name: 'afterall_render_preview',
        description: 'Capture multiple frames evenly distributed across the active composition\'s timeline. Returns array of base64-encoded PNGs with their timestamps. Use to evaluate animation across the whole timeline.',
        inputSchema: {
            type: 'object',
            properties: {
                num_frames: { type: 'integer', default: 4, minimum: 2, maximum: 8 }
            },
            additionalProperties: false
        },
        bridgePath: '/render_preview'
    },
    {
        name: 'afterall_capture_snapshot',
        description: 'Capture a snapshot of the current project state — list of all items and per-comp layer names. Used for protection tracking (which items existed before a task).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/capture_snapshot'
    },
    {
        name: 'afterall_list_voices',
        description: 'List ElevenLabs voices — either user\'s "My Voices" or filtered search of the public library. Returns voice_id, name, gender, age, accent, use case, preview_url.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', enum: ['user', 'library'], default: 'library' },
                gender: { type: 'string', enum: ['male', 'female', 'neutral', 'non-binary'] },
                age: { type: 'string', enum: ['young', 'middle_aged', 'old'] },
                accent: { type: 'string' },
                use_case: { type: 'string', enum: ['narration', 'conversational', 'characters', 'news', 'social_media', 'advertisement', 'audiobook'] },
                search: { type: 'string', description: 'Free-text search.' }
            },
            additionalProperties: false
        },
        bridgePath: '/list_voices'
    },
    {
        name: 'afterall_list_skills',
        description: 'List all available skills — both Python skills (with env + packages) and Markdown recipe skills saved by the agent.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/list_skills'
    },
    {
        name: 'afterall_list_tools_state',
        description: 'List all internal plugin tools (generators, integrations, python skills, background processes) with their enabled/disabled state and current settings.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        bridgePath: '/list_tools_state'
    },
    {
        name: 'afterall_set_feature_flag',
        description: 'Enable or disable an internal plugin feature (imageGen, ttsGen, sttGen, musicGen, sfxGen, videoGen, svgGen, grounding, renderPreview, pythonTools, imageEdit).',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                enabled: { type: 'boolean' }
            },
            required: ['name', 'enabled'],
            additionalProperties: false
        },
        bridgePath: '/set_feature_flag'
    },
    {
        name: 'afterall_get_logs',
        description: 'Get the last N log entries from the plugin (for debugging). Equivalent to the in-panel Log Console.',
        inputSchema: {
            type: 'object',
            properties: { limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 } },
            additionalProperties: false
        },
        bridgePath: '/get_logs'
    }
];
