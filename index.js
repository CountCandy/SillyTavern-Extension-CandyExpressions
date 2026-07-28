/*
 * Candy Expressions - a two-dimensional character expression extension for SillyTavern.
 *
 *   variant (outfit / form / state)  x  emotion / action  ->  sprite
 *
 * The two axes behave differently, on purpose:
 *   - emotion/action : volatile, re-classified every character message.
 *   - variant        : sticky, changes only when you say so, stored per-chat.
 *
 * Sprites reuse SillyTavern's own character sprite storage, one subfolder per
 * variant (the server supports exactly one subfolder level):
 *
 *   /characters/<CharacterName>/<variant>/<label>.png
 *   e.g. Seraphina/armor/joy.png, Seraphina/alien/charging.png
 *
 * Classification is done through the main chat API via generateRaw(), but with
 * our OWN classification system prompt - never the roleplay system prompt or
 * the chat history.
 *
 * This extension is self-contained: it only talks to SillyTavern through the
 * global SillyTavern.getContext() surface, so it is not sensitive to where its
 * folder is installed.
 */

'use strict';

/** @returns {any} SillyTavern context (call fresh - chat/metadata references change per chat) */
function getContext() {
    return SillyTavern.getContext();
}

const MODULE_NAME = 'CandyExpressions';
const EXTENSION_KEY = 'candyExpressions'; // key in extension_settings
const METADATA_KEY = 'candyExpressions';  // key in chat_metadata (per-chat, sticky variant)

const DEFAULT_VARIANT = 'default';

// The 28 GoEmotions-style labels SillyTavern ships with, as our starting emotion set.
const DEFAULT_EMOTIONS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring',
    'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval',
    'disgust', 'embarrassment', 'excitement', 'fear', 'gratitude', 'grief',
    'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization', 'relief',
    'remorse', 'sadness', 'surprise', 'neutral',
].map(label => ({ label, description: '' }));

// Example "action" expressions with descriptions, so the pattern is obvious.
const DEFAULT_ACTIONS = [
    { label: 'charging', description: 'Winding up or rushing forward to launch a physical attack.' },
    { label: 'fighting', description: 'Actively trading blows in close combat right now.' },
    { label: 'jumping', description: 'Leaping or already airborne after a jump.' },
];

const ANSWER_MARKER = 'ANSWER:';

const DEFAULT_CLASSIFY_PROMPT = `You are an expression classifier for a visual-novel engine. You will be shown the most recent line said or narrated for a single character. Decide which ONE label best describes that character's current facial expression, emotion, or physical action.

Available labels:
{{labels}}
{{descriptions}}
Rules:
- Judge only the named character's state - never the user's.
- Pick an action label only if the text clearly shows that physical action happening right now; otherwise pick the closest emotion.
- Prefer the strongest emotion actually shown in the text over a neutral reading.
- If genuinely nothing fits, choose "{{fallback}}".
{{thinking}}
End your reply with the final answer on its own last line, exactly like this:
${ANSWER_MARKER} <label>`;

/** The v1 default; replaced automatically on upgrade if the user never edited it. */
const LEGACY_CLASSIFY_PROMPT_V1 = `You are an expression classifier for a visual-novel engine. You will be shown the most recent line said or narrated for a single character. Pick the ONE label from the list that best matches that character's current facial expression, emotion, or physical action.

Available labels:
{{labels}}
{{descriptions}}
Rules:
- Reply with exactly one label from the list above and nothing else.
- Choose an action label only when the text clearly shows that physical action happening now; otherwise choose the closest emotion.
- If nothing fits, choose "{{fallback}}".
- Output the label in lowercase, with no quotes, punctuation, or extra words.
{{thinking}}`;

/** Reasoning instructions injected by the {{thinking}} macro when thinking is enabled. */
const THINKING_INSTRUCTIONS = `
Before answering, reason briefly and explicitly:
1. What is the character physically doing in this line?
2. What are they feeling, and how strongly?
3. Which single label from the list fits best, and why is it better than the runner-up?
Keep the reasoning short - a few sentences at most.`;

// Optional emoji fallback for the default emotions (used only if enabled and no sprite exists).
const EMOJI_FALLBACK = {
    admiration: '😍', amusement: '😄', anger: '😡', annoyance: '😒', approval: '👍',
    caring: '🤗', confusion: '😕', curiosity: '🤔', desire: '😏', disappointment: '😞',
    disapproval: '👎', disgust: '🤢', embarrassment: '😳', excitement: '🤩', fear: '😨',
    gratitude: '🙏', grief: '😭', joy: '😊', love: '❤️', nervousness: '😬', optimism: '🙂',
    pride: '😌', realization: '💡', relief: '😅', remorse: '😔', sadness: '😢',
    surprise: '😲', neutral: '😐',
};

const SETTINGS_VERSION = 3;

/**
 * Sampler presets for classification. Classification wants consistency, not
 * creativity - but the ideal temperature is model-dependent, so these are a
 * starting point rather than a rule.
 */
const SAMPLER_PRESETS = {
    greedy: { label: 'Greedy', temperature: 0, top_p: 1, top_k: 1, min_p: 0, repetition_penalty: 1 },
    precise: { label: 'Precise', temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1 },
    balanced: { label: 'Balanced', temperature: 0.5, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.02 },
};

const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    enabled: true,
    // classifier
    classifyPrompt: DEFAULT_CLASSIFY_PROMPT,
    filterAvailable: true,       // only offer labels that have a sprite in the active variant
    thinkingEnabled: true,       // allow the classifier model to "think" then strip it
    thinkPrefix: '<think>',
    thinkSuffix: '</think>',
    maxSampleChars: 1400,        // trim very long messages before classifying
    debugLogging: false,         // also mirror each classification to the browser console
    warnMissingSprite: true,     // tell the user when a classified label has no sprite
    maxResponseTokens: 256,      // room for reasoning + the ANSWER line
    // Samplers used for classification requests only - your roleplay preset is untouched.
    sampler: {
        enabled: true,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        min_p: 0.05,
        repetition_penalty: 1,
        clearStopStrings: true,   // roleplay stop strings can cut off the ANSWER line
        neutralizeOthers: true,   // switch off DynaTemp/XTC/DRY/smoothing, which fight the temperature
    },
    // Triggering: only ever runs on AI messages, never when you send one.
    triggerOnSwipe: true,
    triggerOnEdit: true,
    // sprites / display
    defaultVariant: DEFAULT_VARIANT,
    fallbackExpression: 'neutral',
    crossVariantFallback: true,  // if a variant lacks a sprite, borrow from the default variant
    showEmojiFallback: false,    // show an emoji when no sprite is found
    showSpriteWindow: true,      // show the in-chat sprite holder
    chromeless: false,           // hide the holder background/frame
    holder: { x: null, y: null }, // saved holder position (px from left/top)
    // label library (shared across characters)
    emotions: DEFAULT_EMOTIONS,
    actions: DEFAULT_ACTIONS,
    // per-character variant registry, keyed by avatar filename (without extension)
    characters: {},
};

// ------------------------------------------------------------------ //
// Runtime state
// ------------------------------------------------------------------ //
const state = {
    /** @type {{[folder: string]: {label: string, url: string, fileName: string}[]}} */
    spriteCache: {},
    lastEmotion: null,
    lastKey: null,        // dedupe key: variant + message text
    classifyBusy: false,
    classifyQueued: false,
    /** @type {object[]} last N classification round-trips, newest first (see CLASSIFY_LOG_MAX) */
    classifyLog: [],
    settingsCharKey: null, // which character the settings panel is currently showing
    settingsVariant: null, // which variant tab the settings panel is showing
};

// ------------------------------------------------------------------ //
// Settings helpers
// ------------------------------------------------------------------ //
function settings() {
    const es = getContext().extensionSettings;
    if (!es[EXTENSION_KEY]) {
        es[EXTENSION_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    return es[EXTENSION_KEY];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

/** Fill in any missing keys from DEFAULT_SETTINGS (forward-compatible migration). */
function migrateSettings() {
    const s = settings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = structuredClone(value);
        }
    }
    if (!Array.isArray(s.emotions)) s.emotions = structuredClone(DEFAULT_EMOTIONS);
    if (!Array.isArray(s.actions)) s.actions = structuredClone(DEFAULT_ACTIONS);
    if (!s.characters || typeof s.characters !== 'object') s.characters = {};

    // v1 -> v2: the classifier prompt now asks for reasoning and an "ANSWER:" line.
    // Only replace it if the user never customised it.
    if ((s.version ?? 1) < 2) {
        if (!s.classifyPrompt || s.classifyPrompt.trim() === LEGACY_CLASSIFY_PROMPT_V1.trim()) {
            s.classifyPrompt = DEFAULT_CLASSIFY_PROMPT;
        }
        s.version = 2;
    }

    // v2 -> v3: the deterministic on/off switch became a full sampler block.
    if ((s.version ?? 2) < 3) {
        if (s.deterministic === false && s.sampler) s.sampler.enabled = false;
        delete s.deterministic;
        s.version = 3;
    }

    // Fill in any sampler keys added after the user's settings were written.
    if (!s.sampler || typeof s.sampler !== 'object') s.sampler = structuredClone(DEFAULT_SETTINGS.sampler);
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS.sampler)) {
        if (s.sampler[key] === undefined) s.sampler[key] = value;
    }

    saveSettings();
}

/** All library labels, tagged with isAction, sorted alphabetically (emotions and actions mixed). */
function libraryEntries() {
    const s = settings();
    return [
        ...s.emotions.map(e => ({ label: e.label, description: e.description || '', isAction: false })),
        ...s.actions.map(a => ({ label: a.label, description: a.description || '', isAction: true })),
    ].sort((a, b) => a.label.localeCompare(b.label));
}

// ------------------------------------------------------------------ //
// Character / variant helpers
// ------------------------------------------------------------------ //
function avatarKeyOf(char) {
    return String(char?.avatar || char?.name || '').replace(/\.[^/.]+$/, '');
}

/** The character we should show expressions for (single-char chat, or last speaker in a group). */
function getActiveCharacter() {
    const c = getContext();
    if (c.groupId) {
        const last = getLastCharacterMessage();
        if (!last?.name) return null;
        const char = (c.characters || []).find(x => x.name === last.name);
        if (!char) return null;
        return { name: char.name, avatarKey: avatarKeyOf(char) };
    }
    if (c.characterId === undefined || c.characterId === null) return null;
    const char = c.characters?.[c.characterId];
    if (!char) return null;
    return { name: char.name, avatarKey: avatarKeyOf(char) };
}

/** Sprite folder name understood by /api/sprites: "<CharacterName>/<variant>". */
function spriteFolder(charName, variant) {
    return `${charName}/${variant}`;
}

/** Registered variants for a character (always includes the default variant), sorted alphabetically. */
function getVariantsFor(avatarKey) {
    const s = settings();
    const rec = s.characters[avatarKey];
    const list = Array.isArray(rec?.variants) ? rec.variants.slice() : [];
    const def = s.defaultVariant || DEFAULT_VARIANT;
    if (!list.includes(def)) list.push(def);
    return [...new Set(list)].sort((a, b) => a.localeCompare(b));
}

function registerVariant(character, variant) {
    const s = settings();
    const key = character.avatarKey;
    if (!s.characters[key]) s.characters[key] = { name: character.name, variants: [] };
    s.characters[key].name = character.name;
    if (!Array.isArray(s.characters[key].variants)) s.characters[key].variants = [];
    if (!s.characters[key].variants.includes(variant)) {
        s.characters[key].variants.push(variant);
    }
    saveSettings();
}

function unregisterVariant(avatarKey, variant) {
    const s = settings();
    const rec = s.characters[avatarKey];
    if (!rec) return;
    rec.variants = (rec.variants || []).filter(v => v !== variant);
    saveSettings();
}

// --- per-chat sticky variant (the whole point of the extension) --- //
function getCurrentVariant() {
    const c = getContext();
    const v = c.chatMetadata?.[METADATA_KEY]?.variant;
    return v || settings().defaultVariant || DEFAULT_VARIANT;
}

function setCurrentVariant(variant) {
    const c = getContext();
    if (!c.chatMetadata) return;
    if (!c.chatMetadata[METADATA_KEY]) c.chatMetadata[METADATA_KEY] = {};
    c.chatMetadata[METADATA_KEY].variant = variant;
    c.saveMetadataDebounced();
}

// ------------------------------------------------------------------ //
// Sprite loading / cache / upload / delete
// ------------------------------------------------------------------ //
async function loadSprites(charName, variant, force = false) {
    const folder = spriteFolder(charName, variant);
    if (state.spriteCache[folder] && !force) {
        return state.spriteCache[folder];
    }
    try {
        const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`);
        const data = res.ok ? await res.json() : [];
        const sprites = (Array.isArray(data) ? data : []).map(s => ({
            label: String(s.label || '').toLowerCase(),
            url: s.path,
            fileName: String(s.path || '').split('/').pop().split('?')[0],
        }));
        state.spriteCache[folder] = sprites;
        return sprites;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to load sprites for ${folder}`, err);
        state.spriteCache[folder] = [];
        return [];
    }
}

function invalidateSprites(charName, variant) {
    delete state.spriteCache[spriteFolder(charName, variant)];
}

async function uploadSprite(charName, variant, label, file, spriteName) {
    const folder = spriteFolder(charName, variant);
    const form = new FormData();
    form.append('name', folder);
    form.append('label', label);
    form.append('avatar', file);
    form.append('spriteName', spriteName || label);
    const res = await fetch('/api/sprites/upload', {
        method: 'POST',
        headers: getContext().getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    invalidateSprites(charName, variant);
    return res.json().catch(() => ({}));
}

const ZIP_TIMEOUT_MS = 60000;

async function uploadSpriteZip(charName, variant, file) {
    const folder = spriteFolder(charName, variant);
    const form = new FormData();
    form.append('name', folder);
    form.append('avatar', file);

    // SillyTavern's ZIP endpoint can stall on some archives and never respond,
    // which would leave the UI stuck on "Uploading...". Bound the wait.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ZIP_TIMEOUT_MS);
    let res;
    try {
        res = await fetch('/api/sprites/upload-zip', {
            method: 'POST',
            headers: getContext().getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
            signal: controller.signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`SillyTavern's ZIP endpoint did not respond within ${ZIP_TIMEOUT_MS / 1000}s. Use "Batch upload images" instead.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`ZIP upload failed (${res.status})`);
    invalidateSprites(charName, variant);
    return res.json().catch(() => ({}));
}

async function deleteSprite(charName, variant, label, fileName) {
    const folder = spriteFolder(charName, variant);
    const res = await fetch('/api/sprites/delete', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ name: folder, label, spriteName: String(fileName).replace(/\.[^/.]+$/, '') }),
    });
    invalidateSprites(charName, variant);
    return res.ok;
}

// ------------------------------------------------------------------ //
// Classifier
// ------------------------------------------------------------------ //
function getLastCharacterMessage() {
    const c = getContext();
    const chat = c.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        return { mes: m.mes || '', name: m.name, index: i };
    }
    return null;
}

/** Trim + de-noise the text we send to the classifier. */
function sampleText(text) {
    let out = String(text || '').replace(/[*"`]/g, '').trim();
    const max = settings().maxSampleChars || 1400;
    if (out.length > max) {
        const half = Math.floor(max / 2);
        out = out.slice(0, half) + ' [...] ' + out.slice(-half);
    }
    return out;
}

/** Which labels the classifier may choose from for this character/variant. */
function labelsForClassification(charName, variant) {
    const s = settings();
    let labels = libraryEntries().map(e => e.label);
    if (s.filterAvailable) {
        const sprites = state.spriteCache[spriteFolder(charName, variant)] || [];
        const available = new Set(sprites.map(x => x.label));
        const filtered = labels.filter(l => available.has(l));
        if (filtered.length > 0) labels = filtered; // never filter down to nothing
    }
    // de-duplicate while preserving order
    return [...new Set(labels)];
}

function buildClassifyPrompt(labels) {
    const s = settings();
    const described = libraryEntries().filter(e => labels.includes(e.label) && e.description.trim());
    const descBlock = described.length
        ? '\nLabel guide (use to disambiguate, especially actions):\n' +
          described.map(e => `- ${e.label}: ${e.description.trim()}`).join('\n') + '\n'
        : '';
    const thinking = s.thinkingEnabled ? THINKING_INSTRUCTIONS : '\nAnswer immediately, without explanation.';
    return String(s.classifyPrompt)
        .replace(/{{labels}}/g, labels.join(', '))
        .replace(/{{descriptions}}/g, descBlock)
        .replace(/{{thinking}}/g, thinking)
        .replace(/{{fallback}}/g, s.fallbackExpression || 'neutral');
}

/** Reasoning wrappers emitted by common local models, stripped regardless of settings. */
const REASONING_BLOCK_PATTERNS = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reason(?:ing)?>[\s\S]*?<\/reason(?:ing)?>/gi,
    /<reflection>[\s\S]*?<\/reflection>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
    /<\|?begin_of_thought\|?>[\s\S]*?<\|?end_of_thought\|?>/gi,
];

/**
 * Control tags used by "channel"/harmony style models, e.g.
 *   <|channel|>analysis   <|channel>thought   <channel|>final   <|start|>   <|end|>
 * These are markup, not content, so they are always removed.
 */
const CHANNEL_TAG_PATTERN = /<\|[^<>|]*\|?>|<[^<>|]*\|>/g;

/** Strip reasoning so only the model's actual answer text remains. */
function stripThinking(text) {
    const s = settings();
    let out = String(text || '');

    // 1. User-configured delimiters (if they set a custom pair).
    if (s.thinkPrefix && s.thinkSuffix) {
        const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            out = out.replace(new RegExp(`${esc(s.thinkPrefix)}[\\s\\S]*?${esc(s.thinkSuffix)}`, 'g'), ' ');
            // Unterminated block (model never closed the tag): drop everything before the opener.
            const lastOpen = out.lastIndexOf(s.thinkPrefix);
            if (lastOpen >= 0 && !out.includes(s.thinkSuffix)) out = out.slice(lastOpen + s.thinkPrefix.length);
        } catch { /* ignore bad regex */ }
    }

    // 2. Well-known reasoning wrappers.
    for (const re of REASONING_BLOCK_PATTERNS) out = out.replace(re, ' ');

    // 3. Channel/harmony control tags.
    out = out.replace(CHANNEL_TAG_PATTERN, ' ');

    // 4. SillyTavern's own reasoning parser, if the user configured a template.
    try {
        const parsed = getContext().parseReasoningFromString?.(out, { strict: false });
        if (parsed && parsed.content) out = parsed.content;
    } catch { /* ignore */ }

    return out;
}

const normalizeLabel = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Turn a raw model completion into one of our labels. Robust against reasoning noise. */
function parseLabel(raw, labels, fallback) {
    let text = stripThinking(raw);
    const matchLabel = (candidate) => labels.find(l => normalizeLabel(l) === normalizeLabel(candidate));

    // 0. The explicit answer marker wins: "ANSWER: joy" (last occurrence).
    //    This is what makes the parser immune to whatever reasoning format the model uses.
    const answerMatches = [...text.matchAll(/ANSWER\s*[:\-=]\s*(.+)/gi)];
    if (answerMatches.length) {
        const tail = answerMatches[answerMatches.length - 1][1];
        const direct = matchLabel(tail.trim().replace(/[."'`*]/g, ''));
        if (direct) return direct;
        // The line may carry extra words - take the first token that is a known label.
        for (const token of (tail.toLowerCase().match(/[a-z0-9_]+/g) || [])) {
            const hit = matchLabel(token);
            if (hit) return hit;
        }
    }

    // 1. Try structured JSON output: {"label": "..."} / {"emotion": "..."} / {"expression": "..."}
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            const cand = obj.label ?? obj.emotion ?? obj.expression;
            const hit = labels.find(l => normalizeLabel(l) === normalizeLabel(cand));
            if (hit) return hit;
        } catch { /* not JSON */ }
    }

    const normPairs = labels.map(l => [normalizeLabel(l), l]);

    // 2. Scan word tokens from the END; the final answer usually comes last.
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
    for (let i = tokens.length - 1; i >= 0; i--) {
        const n = normalizeLabel(tokens[i]);
        const hit = normPairs.find(([ln]) => ln === n);
        if (hit) return hit[1];
    }

    // 3. Substring containment (last label whose name appears in the text).
    const lower = text.toLowerCase();
    let found = null;
    for (const [ln, orig] of normPairs) {
        const idx = lower.lastIndexOf(orig.toLowerCase());
        if (idx >= 0) found = found && found.idx > idx ? found : { idx, orig };
    }
    if (found) return found.orig;

    console.debug(`[${MODULE_NAME}] Could not parse a label from:`, raw);
    return fallback;
}

/** Classify the given text against the active character/variant and set the sprite. */
async function classifyText(text, { render = true } = {}) {
    const s = settings();
    const character = getActiveCharacter();
    if (!character) return null;
    const variant = getCurrentVariant();

    // make sure the available-sprite filter has data to work with
    await loadSprites(character.name, variant);

    const labels = labelsForClassification(character.name, variant);
    if (labels.length === 0) return null;

    const systemPrompt = buildClassifyPrompt(labels);
    const sampled = sampleText(text);
    const started = Date.now();

    let raw = '';
    try {
        // Main chat API, but with OUR system prompt only (no roleplay prompt, no chat history).
        raw = await withClassificationSamplers(() => getContext().generateRaw({
            prompt: sampled,
            systemPrompt,
            responseLength: s.maxResponseTokens || 256,
        }));
    } catch (err) {
        console.error(`[${MODULE_NAME}] Classification request failed`, err);
        recordClassification({
            character: character.name, variant, labels, systemPrompt,
            sentText: sampled, raw: '', label: null, ms: Date.now() - started,
            error: String(err?.message || err),
        });
        if (typeof toastr !== 'undefined') {
            toastr.error('Candy Expressions could not reach the classifier. Is an API connected?', 'Classification failed');
        }
        return null;
    }

    const label = parseLabel(raw, labels, s.fallbackExpression);
    state.lastEmotion = label;

    // Resolve the sprite so we can report *why* nothing appeared, if nothing does.
    const file = await resolveSprite(character.name, variant, label);
    recordClassification({
        character: character.name, variant, labels, systemPrompt,
        sentText: sampled, raw, label, ms: Date.now() - started, error: null,
        sprite: file ? file.fileName : null,
    });

    if (render) await renderSprite(character.name, variant, label);
    if (!file) warnMissingSprite(character.name, variant, label);
    return label;
}

/** Warn once per variant+label so a missing sprite is visible instead of silent. */
const warnedMissing = new Set();
function warnMissingSprite(charName, variant, label) {
    if (!settings().warnMissingSprite) return;
    const key = `${charName}/${variant}/${label}`;
    if (warnedMissing.has(key)) return;
    warnedMissing.add(key);
    console.warn(`[${MODULE_NAME}] Classified "${label}" but no sprite exists in "${variant}" (and no fallback matched).`);
    if (typeof toastr !== 'undefined') {
        toastr.warning(
            `Classified as "${label}", but there is no sprite for it in variant "${variant}".`,
            'Candy Expressions: no sprite',
            { timeOut: 6000 },
        );
    }
}

// --- classification samplers ------------------------------------------- //
// Classification wants consistency, so it gets its own sampler settings.
// These apply ONLY while a classification request is in flight; the roleplay
// preset is never modified.
let classifyCallDepth = 0;

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const setIfNum = (obj, key, v) => { if (isNum(v)) obj[key] = Number(v); };

function samplerActive() {
    return classifyCallDepth > 0 && settings().sampler?.enabled;
}

/** Text-completion backends (llama.cpp, KoboldCpp, ooba, TabbyAPI...). */
function textSamplerHook(args) {
    if (!samplerActive() || !args || typeof args !== 'object') return;
    const sp = settings().sampler;
    setIfNum(args, 'temperature', sp.temperature);
    setIfNum(args, 'top_p', sp.top_p);
    setIfNum(args, 'top_k', sp.top_k);
    setIfNum(args, 'min_p', sp.min_p);
    setIfNum(args, 'repetition_penalty', sp.repetition_penalty);

    if (sp.neutralizeOthers) {
        // These would otherwise override or fight the temperature above.
        Object.assign(args, {
            dynamic_temperature: false,
            dynatemp_low: undefined,
            dynatemp_high: undefined,
            dynatemp_range: undefined,
            dynatemp_exponent: undefined,
            smoothing_factor: 0,
            dry_multiplier: 0,
            xtc_probability: 0,
            nsigma: 0,
            typical_p: 1,
            typical: 1,
            tfs: 1,
            top_a: 0,
        });
    }

    if (sp.clearStopStrings) {
        Object.assign(args, { stop: [], stopping_strings: [], custom_token_bans: [], banned_tokens: '' });
    }
}

/** Chat-completion backends accept a much smaller set of knobs. */
function chatSamplerHook(args) {
    if (!samplerActive() || !args || typeof args !== 'object') return;
    const sp = settings().sampler;
    setIfNum(args, 'temperature', sp.temperature);
    setIfNum(args, 'top_p', sp.top_p);
    if (isNum(sp.top_k) && Number(sp.top_k) > 0) args.top_k = Number(sp.top_k);
    args.frequency_penalty = 0;
    args.presence_penalty = 0;
    if (sp.clearStopStrings) args.stop = [];
}

/** Run fn with the classification samplers applied for the duration of the request. */
async function withClassificationSamplers(fn) {
    const c = getContext();
    const es = c.eventSource;
    const et = c.eventTypes;
    if (!es || !et || !settings().sampler?.enabled) return fn();

    classifyCallDepth++;
    es.on(et.TEXT_COMPLETION_SETTINGS_READY, textSamplerHook);
    es.on(et.CHAT_COMPLETION_SETTINGS_READY, chatSamplerHook);
    try {
        return await fn();
    } finally {
        classifyCallDepth--;
        es.removeListener?.(et.TEXT_COMPLETION_SETTINGS_READY, textSamplerHook);
        es.removeListener?.(et.CHAT_COMPLETION_SETTINGS_READY, chatSamplerHook);
    }
}

const CLASSIFY_LOG_MAX = 25;

/**
 * Record one classification round-trip so it can be inspected later.
 * This is the audit trail that proves exactly what was (and was not) sent.
 */
function recordClassification(entry) {
    entry.time = new Date().toISOString();
    state.classifyLog.unshift(entry);
    if (state.classifyLog.length > CLASSIFY_LOG_MAX) state.classifyLog.length = CLASSIFY_LOG_MAX;

    if (settings().debugLogging) {
        console.groupCollapsed(`[${MODULE_NAME}] classify -> ${entry.label ?? 'FAILED'} (${entry.ms}ms)`);
        console.log('character:', entry.character, '| variant:', entry.variant);
        console.log('labels offered:', entry.labels.join(', '));
        console.log('--- SYSTEM PROMPT (the ONLY instructions sent) ---\n' + entry.systemPrompt);
        console.log('--- USER MESSAGE SENT ---\n' + entry.sentText);
        console.log('--- RAW MODEL REPLY ---\n' + (entry.raw || '(none)'));
        if (entry.error) console.warn('error:', entry.error);
        console.groupEnd();
    }
}

/** Run one classification on demand and report what happened, end to end. */
async function testClassifier() {
    const character = getActiveCharacter();
    if (!character) { toastr?.warning('Open a character chat first.', 'Candy Expressions'); return; }
    const last = getLastCharacterMessage();
    if (!last?.mes) { toastr?.warning('No character message to classify yet.', 'Candy Expressions'); return; }

    const waiting = toastr?.info('Classifying…', 'Candy Expressions', { timeOut: 0, extendedTimeOut: 0 });
    let label = null;
    try {
        label = await classifyText(last.mes);
    } finally {
        toastr?.clear(waiting);
    }

    const entry = state.classifyLog[0];
    const variant = getCurrentVariant();
    const lines = [
        `<b>Result:</b> ${label ? escapeHtml(label) : '<i>failed</i>'}`,
        `<b>Variant:</b> ${escapeHtml(variant)}`,
        `<b>Sprite shown:</b> ${entry?.sprite ? `<tt>${escapeHtml(entry.sprite)}</tt>` : '<span style="color:#e08a4b">none — no file for this label in this variant</span>'}`,
        `<b>Labels offered:</b> ${entry?.labels?.length ?? 0}`,
        `<b>Took:</b> ${entry?.ms ?? '?'}ms`,
    ];
    if (entry?.error) lines.push(`<b>Error:</b> ${escapeHtml(entry.error)}`);
    if (!entry?.sprite && label) {
        lines.push('', `<span class="candy-hint">Upload a sprite named <tt>${escapeHtml(label)}.png</tt> to the "${escapeHtml(variant)}" variant, or enable the emoji fallback, and it will show up.</span>`);
    }
    lines.push('', '<span class="candy-hint">Open "View classification log" to see the exact prompt and raw reply.</span>');

    await getContext().Popup.show.text('Classifier test', lines.join('<br>'));
}

/**
 * Show the classification log: for each round-trip, the exact system prompt and
 * message that were sent, and the raw reply that came back (thinking included).
 */
async function showClassificationLog() {
    const c = getContext();
    const wrap = document.createElement('div');
    wrap.className = 'candy-popup-block candy-log';

    const title = document.createElement('h3');
    title.textContent = 'Classification Log';
    const hint = document.createElement('p');
    hint.className = 'candy-hint';
    hint.textContent = 'Everything below is the complete payload sent to the classifier. If your roleplay system prompt, persona, or chat history is not shown here, it was not sent.';
    wrap.append(title, hint);

    if (state.classifyLog.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No classifications recorded yet. Send a character message first.';
        wrap.append(empty);
    }

    for (const e of state.classifyLog) {
        const det = document.createElement('details');
        det.className = 'candy-log-entry';
        const sum = document.createElement('summary');
        const when = e.time.replace('T', ' ').replace(/\..*/, '');
        const spriteNote = e.label ? (e.sprite ? ` · ${e.sprite}` : ' · NO SPRITE') : '';
        sum.textContent = `${when} — ${e.character} / ${e.variant} → ${e.label ?? 'FAILED'}${spriteNote} (${e.ms}ms)`;
        if (e.label && !e.sprite) sum.classList.add('candy-log-nosprite');
        det.append(sum);

        const addBlock = (heading, body) => {
            const h = document.createElement('div');
            h.className = 'candy-log-heading';
            h.textContent = heading;
            const pre = document.createElement('pre');
            pre.className = 'candy-log-pre';
            pre.textContent = body || '(empty)';
            det.append(h, pre);
        };
        addBlock('Result', `label: ${e.label ?? '(none)'}\nsprite shown: ${e.sprite ?? 'NONE — no file for this label in this variant'}`);
        addBlock(`Labels offered (${e.labels.length})`, e.labels.join(', '));
        addBlock('SYSTEM PROMPT — the only instructions sent', e.systemPrompt);
        addBlock('USER MESSAGE — the only content sent', e.sentText);
        addBlock('RAW MODEL REPLY (thinking included)', e.raw);
        if (e.error) addBlock('ERROR', e.error);
        wrap.append(det);
    }

    const popup = new c.Popup(wrap, c.POPUP_TYPE.TEXT, '', { okButton: 'Close', allowVerticalScrolling: true, wide: true, large: true });
    await popup.show();
}

/** Classify the latest character message (deduped, serialized). */
async function classifyLatest(force = false) {
    if (!settings().enabled) return;
    if (state.classifyBusy) { state.classifyQueued = true; return; }

    state.classifyBusy = true;
    try {
        do {
            state.classifyQueued = false;
            const fresh = getLastCharacterMessage();
            if (!fresh || !fresh.mes) break;
            const key = `${getCurrentVariant()} ${fresh.mes}`;
            if (!force && key === state.lastKey) break; // already classified this exact state
            force = false;
            state.lastKey = key;
            await classifyText(fresh.mes);
        } while (state.classifyQueued);
    } finally {
        state.classifyBusy = false;
    }
}

// ------------------------------------------------------------------ //
// In-chat sprite display
// ------------------------------------------------------------------ //
function ensureHolder() {
    if (document.getElementById('candy-expression-holder')) return;
    const holder = document.createElement('div');
    holder.id = 'candy-expression-holder';
    // The variant is switched from the toolbar button, not from here - a tiny
    // dropdown floating over the chat was too easy to hit by accident.
    holder.innerHTML = `
        <div class="candy-holder-header">
            <div class="candy-drag-grabber fa-solid fa-grip" title="Drag to move"></div>
            <span class="candy-variant-name" title="Current variant (change it from the toolbar button)"></span>
            <div class="candy-holder-btn candy-open-settings fa-solid fa-gear" title="Manage Candy Expressions"></div>
        </div>
        <img id="candy-expression-image" alt="" draggable="false">
        <div class="candy-emoji-fallback" style="display:none;"></div>
        <div class="candy-empty-note" style="display:none;">No sprite yet<br><span style="opacity:.7">Candy Expressions</span></div>`;
    document.body.appendChild(holder);

    // restore saved position, clamped so an off-screen value can't hide it
    const pos = settings().holder;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        holder.style.left = `${pos.x}px`;
        holder.style.top = `${pos.y}px`;
        holder.style.bottom = 'auto';
    }
    clampHolderIntoView();

    holder.querySelector('.candy-open-settings')?.addEventListener('click', openSettingsPanel);
    const grabber = holder.querySelector('.candy-drag-grabber');
    if (grabber) makeDraggable(holder, grabber);
    applyHolderChrome();
}

/** Keep the window inside the viewport (e.g. after a resize, or a bad saved position). */
function clampHolderIntoView() {
    const holder = document.getElementById('candy-expression-holder');
    if (!holder || holder.classList.contains('candy-hidden')) return;

    const rect = holder.getBoundingClientRect();
    if (!rect.width && !rect.height) return; // not laid out yet

    const MARGIN = 24; // keep at least this much of it reachable
    const maxLeft = Math.max(0, window.innerWidth - MARGIN);
    const maxTop = Math.max(0, window.innerHeight - MARGIN);
    const offscreen = rect.left > maxLeft || rect.top > maxTop || rect.right < MARGIN || rect.bottom < MARGIN;
    if (!offscreen) return;

    const x = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - Math.min(rect.width, 200)));
    const y = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - Math.min(rect.height, 200)));
    holder.style.left = `${x}px`;
    holder.style.top = `${y}px`;
    holder.style.bottom = 'auto';
    settings().holder = { x: Math.round(x), y: Math.round(y) };
    saveSettings();
    console.warn(`[${MODULE_NAME}] Sprite window was off-screen; moved it back into view.`);
}

/** Put the window back at its default spot, make sure it's on, and flash it. */
function locateHolder() {
    settings().showSpriteWindow = true;
    settings().holder = { x: null, y: null };
    saveSettings();

    const showBox = document.getElementById('candy-show-window');
    if (showBox) showBox.checked = true;

    ensureHolder();
    const holder = document.getElementById('candy-expression-holder');
    if (!holder) return;

    holder.classList.remove('candy-hidden');
    holder.style.left = '12px';
    holder.style.top = 'auto';
    holder.style.bottom = '68px';
    applyHolderChrome();
    renderCurrent();

    holder.classList.remove('candy-locating');
    void holder.offsetWidth; // restart the animation
    holder.classList.add('candy-locating');
    setTimeout(() => holder.classList.remove('candy-locating'), 2800);

    toastr?.info('Sprite window reset to the bottom-left and highlighted.', 'Candy Expressions', { timeOut: 4000 });
}

function applyHolderChrome() {
    const holder = document.getElementById('candy-expression-holder');
    if (!holder) return;
    holder.classList.toggle('candy-chromeless', !!settings().chromeless);
    holder.classList.toggle('candy-hidden', !settings().showSpriteWindow);
}

function makeDraggable(holder, handle) {
    let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;
    const onDown = (e) => {
        dragging = true;
        const p = e.touches ? e.touches[0] : e;
        const rect = holder.getBoundingClientRect();
        originX = rect.left; originY = rect.top;
        startX = p.clientX; startY = p.clientY;
        holder.style.bottom = 'auto';
        e.preventDefault();
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    };
    const onMove = (e) => {
        if (!dragging) return;
        const nx = Math.max(0, Math.min(window.innerWidth - 40, originX + (e.clientX - startX)));
        const ny = Math.max(0, Math.min(window.innerHeight - 40, originY + (e.clientY - startY)));
        holder.style.left = `${nx}px`;
        holder.style.top = `${ny}px`;
    };
    const onUp = () => {
        dragging = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        const rect = holder.getBoundingClientRect();
        settings().holder = { x: Math.round(rect.left), y: Math.round(rect.top) };
        saveSettings();
    };
    handle.addEventListener('pointerdown', onDown);
}

function pickSpriteFile(sprites, label) {
    const matches = sprites.filter(x => x.label === label);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return matches[Math.floor(Math.random() * matches.length)];
}

/** Resolve a sprite for label with the fallback chain: variant -> fallback-in-variant -> default variant. */
async function resolveSprite(charName, variant, label) {
    const s = settings();
    const sprites = await loadSprites(charName, variant);
    let file = pickSpriteFile(sprites, label);
    if (!file && s.fallbackExpression) file = pickSpriteFile(sprites, s.fallbackExpression);

    if (!file && s.crossVariantFallback && variant !== s.defaultVariant) {
        const defSprites = await loadSprites(charName, s.defaultVariant);
        file = pickSpriteFile(defSprites, label) || (s.fallbackExpression ? pickSpriteFile(defSprites, s.fallbackExpression) : null);
    }
    return file;
}

/** @returns {Promise<object|null>} the sprite file that was displayed, if any */
async function renderSprite(charName, variant, label) {
    if (!settings().showSpriteWindow) return null;
    ensureHolder();
    updateHolderVariantSelect();

    const img = document.getElementById('candy-expression-image');
    const emoji = document.querySelector('#candy-expression-holder .candy-emoji-fallback');
    const note = document.querySelector('#candy-expression-holder .candy-empty-note');
    if (!img) return null;

    const file = await resolveSprite(charName, variant, label);
    if (file) {
        // Report a broken/404 sprite instead of showing an empty window.
        img.onerror = () => {
            img.onerror = null;
            console.error(`[${MODULE_NAME}] Sprite failed to load: ${file.url}`);
            img.style.display = 'none';
            if (note) {
                note.innerHTML = 'Sprite failed to load<br><span style="opacity:.7">see console</span>';
                note.style.display = '';
            }
            toastr?.error(`Could not load sprite file: ${file.fileName}`, 'Candy Expressions', { timeOut: 8000 });
        };
        img.onload = () => { if (note) note.style.display = 'none'; };
        img.src = file.url;
        img.style.display = '';
        img.title = `${label} (${file.fileName})`;
        if (emoji) emoji.style.display = 'none';
        if (note) note.style.display = 'none';
    } else if (settings().showEmojiFallback && EMOJI_FALLBACK[label]) {
        img.onerror = null;
        img.removeAttribute('src');
        img.style.display = 'none';
        if (note) note.style.display = 'none';
        if (emoji) { emoji.textContent = EMOJI_FALLBACK[label]; emoji.style.display = ''; }
    } else {
        // Nothing to show: keep a small visible placeholder so the window can
        // still be found and moved, rather than collapsing to an invisible box.
        img.onerror = null;
        img.removeAttribute('src');
        img.style.display = 'none';
        if (emoji) emoji.style.display = 'none';
        if (note) {
            note.innerHTML = `No sprite for "${escapeHtml(label)}"<br><span style="opacity:.7">in variant "${escapeHtml(variant)}"</span>`;
            note.style.display = '';
        }
    }

    clampHolderIntoView();
    return file;
}

function clearSprite() {
    const img = document.getElementById('candy-expression-image');
    const emoji = document.querySelector('#candy-expression-holder .candy-emoji-fallback');
    const note = document.querySelector('#candy-expression-holder .candy-empty-note');
    if (img) { img.onerror = null; img.removeAttribute('src'); img.style.display = 'none'; }
    if (emoji) emoji.style.display = 'none';
    if (note) note.style.display = 'none';
}

// ------------------------------------------------------------------ //
// In-chat variant selector (on the holder) + wand-menu quick switch
// ------------------------------------------------------------------ //
/** Reflect the current variant on the sprite window and the toolbar button. */
function updateHolderVariantSelect() {
    const current = getCurrentVariant();

    const name = document.querySelector('#candy-expression-holder .candy-variant-name');
    if (name) name.textContent = current;

    const toolbarLabel = document.querySelector('#candy-toolbar-variant .candy-toolbar-label');
    if (toolbarLabel) toolbarLabel.textContent = current;
}

/** Toolbar button: big, fixed target next to the chat input. */
function addToolbarButton(attempt = 0) {
    if (document.getElementById('candy-toolbar-variant')) return;
    const left = document.getElementById('leftSendForm');
    if (!left) {
        if (attempt < 20) setTimeout(() => addToolbarButton(attempt + 1), 500);
        return;
    }
    const btn = document.createElement('div');
    btn.id = 'candy-toolbar-variant';
    btn.className = 'candy-toolbar-btn interactable';
    btn.tabIndex = 0;
    btn.title = 'Candy Expressions: switch variant (sticky, saved per chat)';
    btn.innerHTML = '<i class="fa-solid fa-masks-theater"></i><span class="candy-toolbar-label"></span>';
    btn.addEventListener('click', openVariantQuickSwitch);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVariantQuickSwitch(); } });
    left.appendChild(btn);
    updateHolderVariantSelect();
}

/** Change the sticky variant and re-render the current emotion in the new variant. */
async function switchVariant(variant) {
    const character = getActiveCharacter();
    if (!character) return;
    setCurrentVariant(variant);
    await loadSprites(character.name, variant, true);
    updateHolderVariantSelect();
    const emotion = state.lastEmotion || settings().fallbackExpression;
    await renderSprite(character.name, variant, emotion);
    if (typeof toastr !== 'undefined') {
        toastr.info(`Variant: ${variant}`, 'Candy Expressions', { timeOut: 1200 });
    }
}

function addWandMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('candy-wand-entry')) return;
    const item = document.createElement('div');
    item.id = 'candy-wand-entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-masks-theater extensionsMenuExtensionButton"></div><span>Candy: Switch Variant</span>';
    item.addEventListener('click', openVariantQuickSwitch);
    menu.appendChild(item);
}

async function openVariantQuickSwitch() {
    const c = getContext();
    const character = getActiveCharacter();
    if (!character) {
        if (typeof toastr !== 'undefined') toastr.warning('Open a single-character chat first.', 'Candy Expressions');
        return;
    }
    const variants = getVariantsFor(character.avatarKey);
    const current = getCurrentVariant();

    const wrap = document.createElement('div');
    wrap.className = 'candy-popup-block';
    const title = document.createElement('h3');
    title.textContent = `Switch Variant — ${character.name}`;
    const hint = document.createElement('p');
    hint.className = 'candy-hint';
    hint.textContent = 'Sticky: stays until you change it, saved with this chat.';
    wrap.append(title, hint);

    const list = document.createElement('div');
    list.className = 'candy-variant-picker';
    wrap.append(list);

    /** @type {any} */
    let popup;
    for (const v of variants) {
        const row = document.createElement('div');
        row.className = 'candy-variant-option' + (v === current ? ' candy-active' : '');
        row.tabIndex = 0;
        const check = document.createElement('i');
        check.className = v === current ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
        const name = document.createElement('span');
        name.className = 'candy-variant-option-name';
        name.textContent = v;
        row.append(check, name);

        const choose = async () => {
            await switchVariant(v);
            popup?.completeAffirmative?.();
        };
        row.addEventListener('click', choose);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
        list.append(row);
    }

    popup = new c.Popup(wrap, c.POPUP_TYPE.TEXT, '', { okButton: 'Close', allowVerticalScrolling: true });
    await popup.show();
}

// ------------------------------------------------------------------ //
// small utils
// ------------------------------------------------------------------ //
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sanitizeVariantName(name) {
    return String(name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').toLowerCase();
}

function sanitizeLabelName(name) {
    return String(name || '').trim().replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

/** Sprite file names may keep "-" and "." suffixes (anger-0003, anger.smug). */
function sanitizeSpriteName(name) {
    return String(name || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
}

// ------------------------------------------------------------------ //
// Settings / management UI
// ------------------------------------------------------------------ //
const SETTINGS_HTML = `
<div class="candy-settings" id="candy-settings-root">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Candy Expressions</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small>Two-dimensional expressions: a sticky <b>variant</b> (outfit / form) times a volatile <b>emotion or action</b>. Disable the built-in "Character Expressions" extension to avoid two sprite windows.</small>

            <label class="checkbox_label" for="candy-enabled"><input type="checkbox" id="candy-enabled"><span>Enable automatic classification</span></label>
            <label class="checkbox_label" for="candy-show-window"><input type="checkbox" id="candy-show-window"><span>Show in-chat sprite window</span></label>
            <label class="checkbox_label" for="candy-chromeless"><input type="checkbox" id="candy-chromeless"><span>Chromeless window (no frame)</span></label>
            <label class="checkbox_label" for="candy-filter-available"><input type="checkbox" id="candy-filter-available"><span>Only offer labels that have a sprite in the active variant</span></label>
            <label class="checkbox_label" for="candy-cross-fallback"><input type="checkbox" id="candy-cross-fallback"><span>Borrow a missing sprite from the default variant</span></label>
            <label class="checkbox_label" for="candy-emoji-fallback"><input type="checkbox" id="candy-emoji-fallback"><span>Show an emoji when no sprite is found</span></label>
            <div class="candy-row">
                <span class="menu_button candy-primary" id="candy-locate" title="Can't see the sprite window? This turns it on, moves it to the bottom-left and flashes it."><i class="fa-solid fa-crosshairs"></i> Find sprite window</span>
            </div>
            <div id="candy-status" class="candy-status"></div>

            <div class="candy-section">
                <div class="candy-section-title"><span>Classifier</span></div>
                <small>Runs on the main chat API, but with this system prompt only — never the roleplay prompt or chat history. Macros: <tt>{{labels}}</tt>, <tt>{{descriptions}}</tt>, <tt>{{fallback}}</tt>, <tt>{{thinking}}</tt>.</small>
                <textarea id="candy-prompt" class="text_pole textarea_compact" rows="8" placeholder="Classification system prompt"></textarea>
                <div class="candy-row">
                    <div class="menu_button" id="candy-prompt-reset"><i class="fa-solid fa-clock-rotate-left"></i> Reset to default</div>
                </div>
                <label class="checkbox_label" for="candy-thinking"><input type="checkbox" id="candy-thinking"><span>Make the classifier reason before answering (recommended - more consistent)</span></label>
                <label class="checkbox_label" for="candy-warn-missing"><input type="checkbox" id="candy-warn-missing"><span>Warn me when a chosen label has no sprite</span></label>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Reply token budget<br><input id="candy-max-tokens" class="text_pole" type="number" min="16" max="2048" step="16"></label>
                </div>
                <small>Reasoning models need room for their thinking plus the final <tt>ANSWER:</tt> line. Raise this if replies look cut off.</small>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Think open (optional)<br><input id="candy-think-prefix" class="text_pole" type="text" placeholder="&lt;think&gt;"></label>
                    <label class="candy-grow">Think close (optional)<br><input id="candy-think-suffix" class="text_pole" type="text" placeholder="&lt;/think&gt;"></label>
                </div>
                <small>Only needed for unusual formats. <tt>&lt;think&gt;</tt>, <tt>&lt;thinking&gt;</tt>, <tt>&lt;reasoning&gt;</tt> and channel-style tags like <tt>&lt;|channel|&gt;</tt> are stripped automatically.</small>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Fallback label<br><select id="candy-fallback" class="text_pole"></select></label>
                </div>
                <div class="candy-row">
                    <span class="menu_button candy-primary" id="candy-test" title="Classify the last character message right now and show the result"><i class="fa-solid fa-vial"></i> Test classifier</span>
                    <span class="menu_button" id="candy-view-log" title="See the exact prompt and reply for recent classifications"><i class="fa-solid fa-magnifying-glass"></i> View classification log</span>
                </div>
                <label class="checkbox_label" for="candy-debug"><input type="checkbox" id="candy-debug"><span>Also log every classification to the browser console (F12)</span></label>
            </div>

            <div class="candy-section">
                <div class="candy-section-title"><span>Sampling</span></div>
                <small>Used for classification requests only — your roleplay preset is never modified. Lower temperature = more consistent labels. <b>0</b> is fully repeatable; <b>0.2–0.5</b> is a good range to experiment in. Leave a field blank to keep your preset's value.</small>
                <label class="checkbox_label" for="candy-sampler-enabled"><input type="checkbox" id="candy-sampler-enabled"><span>Use these samplers for classification</span></label>
                <div class="candy-row">
                    <span>Presets:</span>
                    <span class="menu_button candy-sampler-preset" data-preset="greedy" title="Fully deterministic - identical every time">Greedy</span>
                    <span class="menu_button candy-sampler-preset" data-preset="precise" title="Low randomness, good default for classification">Precise</span>
                    <span class="menu_button candy-sampler-preset" data-preset="balanced" title="A little more variety">Balanced</span>
                </div>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Temperature<br><input id="candy-temp" class="text_pole" type="number" min="0" max="5" step="0.05"></label>
                    <label class="candy-grow">Top P<br><input id="candy-top-p" class="text_pole" type="number" min="0" max="1" step="0.01"></label>
                </div>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Top K<br><input id="candy-top-k" class="text_pole" type="number" min="0" max="200" step="1"></label>
                    <label class="candy-grow">Min P<br><input id="candy-min-p" class="text_pole" type="number" min="0" max="1" step="0.01"></label>
                </div>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Repetition penalty<br><input id="candy-rep-pen" class="text_pole" type="number" min="1" max="2" step="0.01"></label>
                    <label class="candy-grow">Max text sent (chars)<br><input id="candy-sample-chars" class="text_pole" type="number" min="200" max="8000" step="100"></label>
                </div>
                <label class="checkbox_label" for="candy-clear-stops" title="Roleplay stop strings can cut the reply off before the ANSWER line."><input type="checkbox" id="candy-clear-stops"><span>Ignore roleplay stop strings</span></label>
                <label class="checkbox_label" for="candy-neutralize" title="DynaTemp, XTC, DRY and smoothing override or fight a fixed temperature."><input type="checkbox" id="candy-neutralize"><span>Switch off DynaTemp / XTC / DRY / smoothing</span></label>
                <small>Top K, Min P and repetition penalty apply to text-completion backends (llama.cpp, KoboldCpp, ooba, TabbyAPI). Chat-completion endpoints only receive temperature and Top P.</small>
            </div>

            <div class="candy-section">
                <div class="candy-section-title"><span>When to classify</span></div>
                <small>Classification always reads <b>only the most recent AI message</b> — never your messages and never the chat history.</small>
                <label class="checkbox_label" for="candy-trigger-swipe"><input type="checkbox" id="candy-trigger-swipe"><span>Re-classify when you swipe an AI message</span></label>
                <label class="checkbox_label" for="candy-trigger-edit"><input type="checkbox" id="candy-trigger-edit"><span>Re-classify when an AI message is edited</span></label>
            </div>

            <div class="candy-section">
                <div class="candy-section-title">
                    <span>Expression Library</span>
                    <span>
                        <span class="menu_button" id="candy-add-label"><i class="fa-solid fa-plus"></i> Add</span>
                        <span class="menu_button" id="candy-bulk-label"><i class="fa-solid fa-list-ul"></i> Bulk add</span>
                    </span>
                </div>
                <small>Emotions and actions the classifier can pick from (shared across characters). Give actions a description so the model knows when to choose them.</small>
                <div class="candy-label-list" id="candy-label-list"></div>
            </div>

            <div class="candy-section">
                <div class="candy-section-title">
                    <span>Variants &amp; Sprites</span>
                    <span><span class="menu_button" id="candy-add-variant"><i class="fa-solid fa-folder-plus"></i> Add variant(s)</span></span>
                </div>
                <div id="candy-char-name" class="candy-hint"></div>
                <div class="candy-variant-tabs" id="candy-variant-tabs"></div>
                <div class="candy-row">
                    <span class="menu_button candy-primary" id="candy-batch-images" title="Select many images at once - each file is filed under the label in its name (anger-0003.png goes to anger)"><i class="fa-solid fa-images"></i> Batch upload images</span>
                    <span class="menu_button" id="candy-zip-upload" title="Upload a ZIP of images (SillyTavern's own ZIP endpoint - can be flaky; prefer Batch upload images)"><i class="fa-solid fa-file-zipper"></i> ZIP</span>
                    <span class="menu_button" id="candy-refresh-sprites"><i class="fa-solid fa-rotate"></i> Refresh</span>
                    <span class="menu_button candy-danger" id="candy-clear-variant" title="Delete every sprite file in this variant"><i class="fa-solid fa-eraser"></i> Delete all sprites</span>
                    <span class="menu_button candy-danger" id="candy-delete-variant" title="Remove the variant from the list (sprite files are kept)"><i class="fa-solid fa-folder-minus"></i> Remove variant</span>
                </div>
                <div class="candy-sprite-grid" id="candy-sprite-grid"></div>
                <p class="candy-hint">Sprites live in <tt>/characters/&lt;name&gt;/&lt;variant&gt;/&lt;label&gt;.png</tt>. Batch upload sorts by file name: <tt>anger.png</tt>, <tt>anger-0003.png</tt> and <tt>anger.smug.png</tt> all land under <b>anger</b>. A <tt>*</tt> marks a sprite whose label isn't in your library.</p>
            </div>
        </div>
    </div>
    <input type="file" id="candy-file-input" accept="image/*" hidden>
    <input type="file" id="candy-batch-input" accept="image/*" multiple hidden>
    <input type="file" id="candy-zip-input" accept="application/zip,.zip" hidden>
</div>`;

function injectSettingsPanel(attempt = 0) {
    if (document.getElementById('candy-settings-root')) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        if (attempt < 20) setTimeout(() => injectSettingsPanel(attempt + 1), 500);
        return;
    }
    container.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    wireSettingsPanel();
    refreshSettingsCharContext();
}

function wireSettingsPanel() {
    const s = settings();
    const $id = (id) => document.getElementById(id);

    const bindCheckbox = (id, key, after) => {
        const el = $id(id);
        if (!el) return;
        el.checked = !!s[key];
        el.addEventListener('change', () => { settings()[key] = el.checked; saveSettings(); if (after) after(el.checked); });
    };
    bindCheckbox('candy-enabled', 'enabled');
    bindCheckbox('candy-show-window', 'showSpriteWindow', () => { applyHolderChrome(); if (settings().showSpriteWindow) renderCurrent(); });
    bindCheckbox('candy-chromeless', 'chromeless', applyHolderChrome);
    bindCheckbox('candy-filter-available', 'filterAvailable');
    bindCheckbox('candy-cross-fallback', 'crossVariantFallback');
    bindCheckbox('candy-emoji-fallback', 'showEmojiFallback');

    const prompt = $id('candy-prompt');
    if (prompt) {
        prompt.value = s.classifyPrompt;
        prompt.addEventListener('input', () => { settings().classifyPrompt = prompt.value; saveSettings(); });
    }
    $id('candy-prompt-reset')?.addEventListener('click', () => {
        settings().classifyPrompt = DEFAULT_CLASSIFY_PROMPT;
        if (prompt) prompt.value = DEFAULT_CLASSIFY_PROMPT;
        saveSettings();
    });

    const bindText = (id, key) => {
        const el = $id(id);
        if (!el) return;
        el.value = s[key] ?? '';
        el.addEventListener('input', () => { settings()[key] = el.value; saveSettings(); });
    };
    const thinkBox = $id('candy-thinking');
    if (thinkBox) {
        thinkBox.checked = !!s.thinkingEnabled;
        thinkBox.addEventListener('change', (e) => { settings().thinkingEnabled = e.target.checked; saveSettings(); });
    }
    bindCheckbox('candy-warn-missing', 'warnMissingSprite');
    bindCheckbox('candy-trigger-swipe', 'triggerOnSwipe');
    bindCheckbox('candy-trigger-edit', 'triggerOnEdit');
    wireSamplerControls();

    const maxTok = $id('candy-max-tokens');
    if (maxTok) {
        maxTok.value = s.maxResponseTokens ?? 256;
        maxTok.addEventListener('change', () => {
            const v = parseInt(maxTok.value, 10);
            settings().maxResponseTokens = Number.isFinite(v) ? Math.min(2048, Math.max(16, v)) : 256;
            maxTok.value = settings().maxResponseTokens;
            saveSettings();
        });
    }

    $id('candy-test')?.addEventListener('click', testClassifier);
    $id('candy-locate')?.addEventListener('click', locateHolder);
    bindText('candy-think-prefix', 'thinkPrefix');
    bindText('candy-think-suffix', 'thinkSuffix');

    populateFallbackSelect();
    $id('candy-fallback')?.addEventListener('change', (e) => { settings().fallbackExpression = e.target.value; saveSettings(); });

    // Library
    $id('candy-add-label')?.addEventListener('click', addLabelDialog);
    $id('candy-bulk-label')?.addEventListener('click', bulkAddLabelsDialog);
    $id('candy-label-list')?.addEventListener('click', onLabelListClick);

    // Variants & sprites
    $id('candy-add-variant')?.addEventListener('click', addVariantDialog);
    $id('candy-delete-variant')?.addEventListener('click', deleteVariantDialog);
    $id('candy-refresh-sprites')?.addEventListener('click', async () => { await refreshActiveSprites(); });
    $id('candy-view-log')?.addEventListener('click', showClassificationLog);
    const debugBox = $id('candy-debug');
    if (debugBox) {
        debugBox.checked = !!s.debugLogging;
        debugBox.addEventListener('change', (e) => { settings().debugLogging = e.target.checked; saveSettings(); });
    }

    $id('candy-batch-images')?.addEventListener('click', () => {
        const input = $id('candy-batch-input');
        if (input) { input.value = ''; input.click(); }
    });
    $id('candy-batch-input')?.addEventListener('change', onBatchImagesChosen);
    $id('candy-clear-variant')?.addEventListener('click', clearVariantSpritesDialog);
    $id('candy-zip-upload')?.addEventListener('click', () => $id('candy-zip-input')?.click());
    $id('candy-variant-tabs')?.addEventListener('click', onVariantTabClick);
    $id('candy-sprite-grid')?.addEventListener('click', onSpriteGridClick);
    $id('candy-file-input')?.addEventListener('change', onSpriteFileChosen);
    $id('candy-zip-input')?.addEventListener('change', onZipChosen);

    renderLabelList();
    updateStatusLine();
    // Refresh the status line while the settings panel is open.
    setInterval(() => {
        const root = document.getElementById('candy-settings-root');
        const content = root?.querySelector('.inline-drawer-content');
        if (content && getComputedStyle(content).display !== 'none') updateStatusLine();
    }, 1500);
}

/** Live one-line status: is the window on screen, and what is it showing? */
function updateStatusLine() {
    const el = document.getElementById('candy-status');
    if (!el) return;

    const bits = [];
    const character = getActiveCharacter();
    bits.push(character ? `Character: <b>${escapeHtml(character.name)}</b>` : '<b>No character chat open</b>');
    if (character) bits.push(`Variant: <b>${escapeHtml(getCurrentVariant())}</b>`);

    if (!settings().showSpriteWindow) {
        bits.push('Window: <b>hidden</b> (enable it above)');
    } else {
        const holder = document.getElementById('candy-expression-holder');
        if (!holder) {
            bits.push('Window: <b>not created yet</b>');
        } else {
            const r = holder.getBoundingClientRect();
            const onScreen = r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
            bits.push(`Window: <b>${onScreen ? 'on screen' : 'OFF SCREEN'}</b> at ${Math.round(r.left)},${Math.round(r.top)}`);
        }
        const img = document.getElementById('candy-expression-image');
        const src = img?.getAttribute('src');
        bits.push(src
            ? `Showing: <tt>${escapeHtml(decodeURIComponent(src.split('/').pop().split('?')[0]))}</tt>`
            : 'Showing: <b>nothing</b>');
    }
    if (state.lastEmotion) bits.push(`Last label: <b>${escapeHtml(state.lastEmotion)}</b>`);

    el.innerHTML = bits.join(' &nbsp;·&nbsp; ');
}

/** Sampler fields: id -> key in settings().sampler. Blank input = don't override. */
const SAMPLER_FIELDS = {
    'candy-temp': 'temperature',
    'candy-top-p': 'top_p',
    'candy-top-k': 'top_k',
    'candy-min-p': 'min_p',
    'candy-rep-pen': 'repetition_penalty',
};

function wireSamplerControls() {
    const s = settings();
    const $id = (id) => document.getElementById(id);

    const enabled = $id('candy-sampler-enabled');
    if (enabled) {
        enabled.checked = !!s.sampler.enabled;
        enabled.addEventListener('change', () => {
            settings().sampler.enabled = enabled.checked;
            saveSettings();
            updateSamplerFieldState();
        });
    }

    for (const [id, key] of Object.entries(SAMPLER_FIELDS)) {
        const el = $id(id);
        if (!el) continue;
        el.value = s.sampler[key] ?? '';
        el.addEventListener('change', () => {
            const raw = el.value.trim();
            settings().sampler[key] = raw === '' ? null : Number(raw);
            saveSettings();
        });
    }

    const chars = $id('candy-sample-chars');
    if (chars) {
        chars.value = s.maxSampleChars ?? 1400;
        chars.addEventListener('change', () => {
            const v = parseInt(chars.value, 10);
            settings().maxSampleChars = Number.isFinite(v) ? Math.min(8000, Math.max(200, v)) : 1400;
            chars.value = settings().maxSampleChars;
            saveSettings();
        });
    }

    const bindSamplerBool = (id, key) => {
        const el = $id(id);
        if (!el) return;
        el.checked = !!s.sampler[key];
        el.addEventListener('change', () => { settings().sampler[key] = el.checked; saveSettings(); });
    };
    bindSamplerBool('candy-clear-stops', 'clearStopStrings');
    bindSamplerBool('candy-neutralize', 'neutralizeOthers');

    for (const btn of document.querySelectorAll('.candy-sampler-preset')) {
        btn.addEventListener('click', () => applySamplerPreset(btn.dataset.preset));
    }

    updateSamplerFieldState();
}

function applySamplerPreset(name) {
    const preset = SAMPLER_PRESETS[name];
    if (!preset) return;
    const sp = settings().sampler;
    for (const key of Object.values(SAMPLER_FIELDS)) {
        if (preset[key] !== undefined) sp[key] = preset[key];
    }
    sp.enabled = true;
    saveSettings();

    // reflect in the inputs
    const enabled = document.getElementById('candy-sampler-enabled');
    if (enabled) enabled.checked = true;
    for (const [id, key] of Object.entries(SAMPLER_FIELDS)) {
        const el = document.getElementById(id);
        if (el) el.value = sp[key] ?? '';
    }
    updateSamplerFieldState();
    toastr?.info(`Sampler preset: ${preset.label}`, 'Candy Expressions', { timeOut: 1500 });
}

/** Grey out the sampler inputs when the override is switched off. */
function updateSamplerFieldState() {
    const on = !!settings().sampler.enabled;
    const ids = [...Object.keys(SAMPLER_FIELDS), 'candy-clear-stops', 'candy-neutralize'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.disabled = !on;
    }
    for (const btn of document.querySelectorAll('.candy-sampler-preset')) {
        btn.classList.toggle('candy-disabled', !on);
    }
}

function populateFallbackSelect() {
    const select = document.getElementById('candy-fallback');
    if (!select) return;
    const s = settings();
    const labels = s.emotions.map(e => e.label);
    if (!labels.includes(s.fallbackExpression)) labels.unshift(s.fallbackExpression);
    select.innerHTML = labels.map(l => `<option value="${escapeHtml(l)}"${l === s.fallbackExpression ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('');
}

function renderLabelList() {
    const container = document.getElementById('candy-label-list');
    if (!container) return;
    const entries = libraryEntries();
    container.innerHTML = entries.map(e => `
        <div class="candy-label-item" data-label="${escapeHtml(e.label)}" data-action="${e.isAction}">
            <span class="candy-label-name ${e.isAction ? 'candy-is-action' : ''}">${escapeHtml(e.label)}</span>
            ${e.isAction ? '<span class="candy-badge">action</span>' : ''}
            <span class="candy-label-desc" title="${escapeHtml(e.description || '')}">${escapeHtml(e.description || '')}</span>
            <span class="candy-mini-btn fa-solid fa-pen candy-edit-label" title="Edit"></span>
            <span class="candy-mini-btn fa-solid fa-xmark candy-danger candy-del-label" title="Remove"></span>
        </div>`).join('') || '<div class="candy-hint">No labels yet — add some.</div>';
}

async function onLabelListClick(ev) {
    const item = ev.target.closest('.candy-label-item');
    if (!item) return;
    const label = item.dataset.label;
    if (ev.target.classList.contains('candy-del-label')) {
        removeLabel(label);
    } else if (ev.target.classList.contains('candy-edit-label')) {
        await editLabelDialog(label);
    }
}

function findEntry(label) {
    const s = settings();
    let idx = s.emotions.findIndex(e => e.label === label);
    if (idx >= 0) return { arr: s.emotions, idx, isAction: false };
    idx = s.actions.findIndex(e => e.label === label);
    if (idx >= 0) return { arr: s.actions, idx, isAction: true };
    return null;
}

function removeLabel(label) {
    const found = findEntry(label);
    if (!found) return;
    found.arr.splice(found.idx, 1);
    saveSettings();
    renderLabelList();
    populateFallbackSelect();
    renderSpriteGrid();
}

async function labelEditorPopup(titleText, { name = '', description = '', isAction = false, lockName = false } = {}) {
    const c = getContext();
    const wrap = document.createElement('div');
    wrap.className = 'candy-popup-block';
    const nameInput = document.createElement('input');
    nameInput.className = 'text_pole';
    nameInput.placeholder = 'label name (letters/numbers, e.g. charging)';
    nameInput.value = name;
    nameInput.disabled = lockName;
    const descInput = document.createElement('textarea');
    descInput.className = 'text_pole';
    descInput.style.minHeight = '70px';
    descInput.placeholder = 'Description (recommended for actions)';
    descInput.value = description;
    const actLabel = document.createElement('label');
    actLabel.className = 'checkbox_label';
    const actInput = document.createElement('input');
    actInput.type = 'checkbox';
    actInput.checked = isAction;
    actLabel.append(actInput, document.createTextNode(' This is an action (not an emotion)'));

    wrap.append(
        Object.assign(document.createElement('h3'), { textContent: titleText }),
        Object.assign(document.createElement('div'), { className: 'candy-hint', textContent: 'Label name = sprite file name, e.g. charging -> charging.png' }),
        nameInput, descInput, actLabel,
    );
    const popup = new c.Popup(wrap, c.POPUP_TYPE.TEXT, '', { okButton: 'Save', cancelButton: 'Cancel' });
    const result = await popup.show();
    if (!result) return null;
    return { name: nameInput.value, description: descInput.value, isAction: actInput.checked };
}

async function addLabelDialog() {
    const data = await labelEditorPopup('Add expression');
    if (!data) return;
    const label = sanitizeLabelName(data.name);
    if (!label) { toastr?.warning('Enter a valid label name.', 'Candy Expressions'); return; }
    if (findEntry(label)) { toastr?.warning(`"${label}" already exists.`, 'Candy Expressions'); return; }
    const entry = { label, description: data.description.trim() };
    (data.isAction ? settings().actions : settings().emotions).push(entry);
    saveSettings();
    renderLabelList();
    populateFallbackSelect();
    renderSpriteGrid();
}

async function editLabelDialog(label) {
    const found = findEntry(label);
    if (!found) return;
    const entry = found.arr[found.idx];
    const data = await labelEditorPopup(`Edit "${label}"`, { name: label, description: entry.description || '', isAction: found.isAction, lockName: true });
    if (!data) return;
    entry.description = data.description.trim();
    // move between emotion/action arrays if the type changed
    if (data.isAction !== found.isAction) {
        found.arr.splice(found.idx, 1);
        (data.isAction ? settings().actions : settings().emotions).push(entry);
    }
    saveSettings();
    renderLabelList();
    renderSpriteGrid();
}

async function bulkAddLabelsDialog() {
    const c = getContext();
    const wrap = document.createElement('div');
    wrap.className = 'candy-popup-block';
    const ta = document.createElement('textarea');
    ta.placeholder = 'One per line:\ncharging: rushing forward to attack\njumping: leaping into the air\nsurprise';
    const actLabel = document.createElement('label');
    actLabel.className = 'checkbox_label';
    const actInput = document.createElement('input');
    actInput.type = 'checkbox';
    actInput.checked = true;
    actLabel.append(actInput, document.createTextNode(' Add these as actions'));
    wrap.append(
        Object.assign(document.createElement('h3'), { textContent: 'Bulk add expressions' }),
        Object.assign(document.createElement('div'), { className: 'candy-hint', textContent: 'Format: "label: description" (description optional).' }),
        ta, actLabel,
    );
    const popup = new c.Popup(wrap, c.POPUP_TYPE.TEXT, '', { okButton: 'Add', cancelButton: 'Cancel' });
    const result = await popup.show();
    if (!result) return;

    const asAction = actInput.checked;
    let added = 0;
    for (const line of ta.value.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const rawName = sep >= 0 ? trimmed.slice(0, sep) : trimmed;
        const desc = sep >= 0 ? trimmed.slice(sep + 1).trim() : '';
        const label = sanitizeLabelName(rawName);
        if (!label || findEntry(label)) continue;
        (asAction ? settings().actions : settings().emotions).push({ label, description: desc });
        added++;
    }
    saveSettings();
    renderLabelList();
    populateFallbackSelect();
    renderSpriteGrid();
    toastr?.success(`Added ${added} expression(s).`, 'Candy Expressions');
}

// --- variants & sprite grid (settings) --- //
function refreshSettingsCharContext() {
    if (!document.getElementById('candy-settings-root')) return;
    const character = getActiveCharacter();
    const nameEl = document.getElementById('candy-char-name');
    if (nameEl) nameEl.textContent = character ? `Character: ${character.name}` : 'Open a single-character chat to manage variants & sprites.';
    if (character) {
        const variants = getVariantsFor(character.avatarKey);
        if (!state.settingsVariant || !variants.includes(state.settingsVariant)) {
            state.settingsVariant = getCurrentVariant();
            if (!variants.includes(state.settingsVariant)) state.settingsVariant = variants[0];
        }
    }
    renderVariantTabs();
    renderSpriteGrid();
}

function renderVariantTabs() {
    const tabs = document.getElementById('candy-variant-tabs');
    if (!tabs) return;
    const character = getActiveCharacter();
    if (!character) { tabs.innerHTML = ''; return; }
    const variants = getVariantsFor(character.avatarKey);
    const active = state.settingsVariant || getCurrentVariant();
    tabs.innerHTML = variants.map(v =>
        `<span class="candy-variant-tab ${v === active ? 'candy-active' : ''}" data-variant="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('');
}

function onVariantTabClick(ev) {
    const tab = ev.target.closest('.candy-variant-tab');
    if (!tab) return;
    state.settingsVariant = tab.dataset.variant;
    renderVariantTabs();
    renderSpriteGrid();
}

async function renderSpriteGrid() {
    const grid = document.getElementById('candy-sprite-grid');
    if (!grid) return;
    const character = getActiveCharacter();
    if (!character) { grid.innerHTML = ''; return; }
    const variant = state.settingsVariant || getCurrentVariant();
    const sprites = await loadSprites(character.name, variant, true);

    const byLabel = {};
    for (const sp of sprites) (byLabel[sp.label] = byLabel[sp.label] || []).push(sp);

    const entries = libraryEntries();
    const libLabels = new Set(entries.map(e => e.label));

    // Library labels + any on-disk labels not in the library, all mixed and sorted A-Z.
    const all = [
        ...entries.map(e => ({ label: e.label, isAction: e.isAction, isExtra: false })),
        ...[...new Set(sprites.map(s => s.label))]
            .filter(l => !libLabels.has(l))
            .map(l => ({ label: l, isAction: false, isExtra: true })),
    ].sort((a, b) => a.label.localeCompare(b.label));

    const tile = ({ label, isAction, isExtra }) => {
        const files = byLabel[label] || [];
        const file = files.length ? files[0] : null;
        const extraCount = files.length > 1 ? `<span class="candy-sprite-count" title="${files.length} sprites for this label">${files.length}</span>` : '';
        return `
        <div class="candy-sprite-tile ${file ? '' : 'candy-missing'}" data-label="${escapeHtml(label)}">
            ${file
                ? `<img class="candy-sprite-thumb" src="${file.url}" title="${escapeHtml(label)} — click to preview" data-file="${escapeHtml(file.fileName)}" loading="lazy">`
                : '<div class="candy-sprite-thumb candy-placeholder"><i class="fa-solid fa-image"></i></div>'}
            ${extraCount}
            <div class="candy-sprite-label ${isAction ? 'candy-is-action' : ''}${isExtra ? ' candy-is-extra' : ''}" title="${escapeHtml(label)}${isExtra ? ' (not in your library)' : ''}">${escapeHtml(label)}${isExtra ? ' *' : ''}</div>
            <div class="candy-sprite-actions">
                <span class="candy-mini-btn fa-solid fa-upload candy-upload-sprite" title="Upload sprite"></span>
                ${file ? `<span class="candy-mini-btn fa-solid fa-trash-can candy-danger candy-del-sprite" title="Delete sprite" data-file="${escapeHtml(file.fileName)}"></span>` : ''}
            </div>
        </div>`;
    };

    grid.innerHTML = all.map(tile).join('');
}

async function onSpriteGridClick(ev) {
    const tile = ev.target.closest('.candy-sprite-tile');
    if (!tile) return;
    const label = tile.dataset.label;
    const character = getActiveCharacter();
    if (!character) return;
    const variant = state.settingsVariant || getCurrentVariant();

    if (ev.target.classList.contains('candy-upload-sprite')) {
        state.uploadTarget = { charName: character.name, variant, label };
        document.getElementById('candy-file-input').value = '';
        document.getElementById('candy-file-input').click();
    } else if (ev.target.classList.contains('candy-del-sprite')) {
        const fileName = ev.target.dataset.file;
        const ok = await getContext().Popup.show.confirm('Delete sprite', `Delete <tt>${escapeHtml(fileName)}</tt> from <tt>${escapeHtml(variant)}</tt>?`);
        if (!ok) return;
        await deleteSprite(character.name, variant, label, fileName);
        await renderSpriteGrid();
        renderCurrent();
    } else if (ev.target.classList.contains('candy-sprite-thumb') && !ev.target.classList.contains('candy-placeholder')) {
        // Preview this label in the in-chat window
        state.lastEmotion = label;
        await renderSprite(character.name, getCurrentVariant(), label);
    }
}

async function onSpriteFileChosen(ev) {
    const file = ev.target.files[0];
    const target = state.uploadTarget;
    if (!file || !target) return;
    try {
        await uploadSprite(target.charName, target.variant, target.label, file, target.label);
        toastr?.success(`Uploaded ${target.label} for ${target.variant}.`, 'Candy Expressions');
        await renderSpriteGrid();
        renderCurrent();
    } catch (err) {
        console.error(err);
        toastr?.error('Upload failed.', 'Candy Expressions');
    } finally {
        state.uploadTarget = null;
        ev.target.value = '';
    }
}

/**
 * Derive the expression label from a sprite file name, mirroring SillyTavern's
 * own server-side rule: everything before the first "-" or "." suffix.
 *   anger.png -> anger | anger-0003.png -> anger | anger.smug.png -> anger
 */
function deriveLabelFromFileName(fileName) {
    const base = String(fileName).replace(/\.[^/.]+$/, '').toLowerCase();
    return base.match(/^(.+?)(?:[-.].*?)?$/)?.[1] ?? base;
}

/** Batch upload: many images at once, each auto-filed under the label in its name. */
async function onBatchImagesChosen(ev) {
    const files = [...(ev.target.files || [])];
    const character = getActiveCharacter();
    if (!files.length || !character) { ev.target.value = ''; return; }

    const variant = state.settingsVariant || getCurrentVariant();
    const plan = files.map(file => {
        const base = file.name.replace(/\.[^/.]+$/, '').toLowerCase();
        return { file, label: deriveLabelFromFileName(file.name), spriteName: sanitizeSpriteName(base) };
    }).filter(p => p.label && p.spriteName);

    if (!plan.length) {
        toastr?.warning('No usable file names found.', 'Candy Expressions');
        ev.target.value = '';
        return;
    }

    const progress = toastr?.info(`Uploading 0/${plan.length}…`, 'Candy Expressions', { timeOut: 0, extendedTimeOut: 0 });
    let done = 0;
    const failed = [];
    // Sequential: the sprite endpoint rewrites a whole folder per call, so parallel
    // uploads into the same folder can race.
    for (const p of plan) {
        try {
            await uploadSprite(character.name, variant, p.label, p.file, p.spriteName);
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to upload ${p.file.name}`, err);
            failed.push(p.file.name);
        }
        done++;
        if (progress?.find) {
            const el = progress.find('.toast-message');
            if (el?.length) el.text(`Uploading ${done}/${plan.length}…`);
        }
    }
    toastr?.clear(progress);

    const okCount = plan.length - failed.length;
    if (okCount) toastr?.success(`Uploaded ${okCount} sprite(s) to "${variant}".`, 'Candy Expressions');
    if (failed.length) toastr?.error(`${failed.length} failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`, 'Candy Expressions');

    // Offer to add any labels that aren't in the library yet.
    const known = new Set(libraryEntries().map(e => e.label));
    const unknown = [...new Set(plan.map(p => p.label))].filter(l => !known.has(l));
    if (unknown.length) {
        const add = await getContext().Popup.show.confirm(
            'Add new labels?',
            `${unknown.length} uploaded sprite(s) use labels that aren't in your Expression Library yet:<br><br><tt>${escapeHtml(unknown.join(', '))}</tt><br><br>Add them so the classifier can choose them?`,
        );
        if (add) {
            for (const label of unknown) {
                if (!findEntry(label)) settings().emotions.push({ label, description: '' });
            }
            saveSettings();
            renderLabelList();
            populateFallbackSelect();
        }
    }

    await renderSpriteGrid();
    renderCurrent();
    ev.target.value = '';
}

/** Delete every sprite file in the active variant. */
async function clearVariantSpritesDialog() {
    const character = getActiveCharacter();
    if (!character) { toastr?.warning('Open a character chat first.', 'Candy Expressions'); return; }
    const variant = state.settingsVariant || getCurrentVariant();
    const sprites = await loadSprites(character.name, variant, true);

    if (!sprites.length) {
        toastr?.info(`"${variant}" has no sprites to delete.`, 'Candy Expressions');
        return;
    }

    const ok = await getContext().Popup.show.confirm(
        'Delete all sprites',
        `Permanently delete all <b>${sprites.length}</b> sprite file(s) in <tt>${escapeHtml(character.name)}/${escapeHtml(variant)}</tt>?<br><br><span class="candy-hint">This deletes the image files from disk. It cannot be undone.</span>`,
    );
    if (!ok) return;

    const progress = toastr?.info(`Deleting 0/${sprites.length}…`, 'Candy Expressions', { timeOut: 0, extendedTimeOut: 0 });
    let done = 0, failed = 0;
    for (const sp of sprites) {
        const success = await deleteSprite(character.name, variant, sp.label, sp.fileName).catch(() => false);
        if (!success) failed++;
        done++;
        if (progress?.find) {
            const el = progress.find('.toast-message');
            if (el?.length) el.text(`Deleting ${done}/${sprites.length}…`);
        }
    }
    toastr?.clear(progress);
    if (failed) toastr?.error(`${failed} sprite(s) could not be deleted.`, 'Candy Expressions');
    else toastr?.success(`Deleted ${sprites.length} sprite(s) from "${variant}".`, 'Candy Expressions');

    await renderSpriteGrid();
    clearSprite();
    renderCurrent();
}

async function onZipChosen(ev) {
    const file = ev.target.files[0];
    const character = getActiveCharacter();
    if (!file || !character) { ev.target.value = ''; return; }
    const variant = state.settingsVariant || getCurrentVariant();
    const waiting = toastr?.info('Uploading…', 'Candy Expressions', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const { count } = await uploadSpriteZip(character.name, variant, file);
        toastr?.clear(waiting);
        toastr?.success(`Uploaded ${count || 0} sprite(s) to ${variant}.`, 'Candy Expressions');
        await renderSpriteGrid();
        renderCurrent();
    } catch (err) {
        toastr?.clear(waiting);
        console.error(err);
        toastr?.error(String(err?.message || 'ZIP upload failed.'), 'Candy Expressions', { timeOut: 10000 });
    } finally {
        ev.target.value = '';
    }
}

async function addVariantDialog() {
    const character = getActiveCharacter();
    if (!character) { toastr?.warning('Open a character chat first.', 'Candy Expressions'); return; }
    const input = await getContext().Popup.show.input('Add variant(s)', 'Comma-separated (e.g. <tt>armor, suit, alien</tt>). Creates a sprite subfolder per variant.');
    if (!input) return;
    const names = input.split(',').map(sanitizeVariantName).filter(Boolean);
    let first = null;
    for (const name of names) { registerVariant(character, name); if (!first) first = name; }
    if (first) state.settingsVariant = first;
    refreshSettingsCharContext();
    updateHolderVariantSelect();
    toastr?.success(`Added ${names.length} variant(s).`, 'Candy Expressions');
}

async function deleteVariantDialog() {
    const character = getActiveCharacter();
    if (!character) return;
    const variant = state.settingsVariant || getCurrentVariant();
    if (variant === (settings().defaultVariant || DEFAULT_VARIANT)) {
        toastr?.warning('The default variant cannot be removed.', 'Candy Expressions');
        return;
    }
    const ok = await getContext().Popup.show.confirm('Remove variant', `Remove variant <tt>${escapeHtml(variant)}</tt> from the list?<br><br><span class="candy-hint">Sprite files on disk are kept; only the registration is removed.</span>`);
    if (!ok) return;
    unregisterVariant(character.avatarKey, variant);
    if (getCurrentVariant() === variant) setCurrentVariant(settings().defaultVariant || DEFAULT_VARIANT);
    state.settingsVariant = null;
    refreshSettingsCharContext();
    updateHolderVariantSelect();
    renderCurrent();
}

async function refreshActiveSprites() {
    const character = getActiveCharacter();
    if (!character) return;
    const variant = state.settingsVariant || getCurrentVariant();
    await loadSprites(character.name, variant, true);
    await renderSpriteGrid();
    renderCurrent();
}

function openSettingsPanel() {
    const root = document.getElementById('candy-settings-root');
    if (!root) return;
    const content = root.querySelector('.inline-drawer-content');
    const toggle = root.querySelector('.inline-drawer-toggle');
    if (content && toggle && getComputedStyle(content).display === 'none') toggle.click();
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Re-render the in-chat sprite for the current character/variant/emotion. */
function renderCurrent() {
    const character = getActiveCharacter();
    if (!character) return;
    renderSprite(character.name, getCurrentVariant(), state.lastEmotion || settings().fallbackExpression);
}

// ------------------------------------------------------------------ //
// Event wiring
// ------------------------------------------------------------------ //
let triggerTimer = null;
function triggerClassify(force = false) {
    clearTimeout(triggerTimer);
    triggerTimer = setTimeout(() => classifyLatest(force).catch(e => console.error(`[${MODULE_NAME}]`, e)), 250);
}

async function onChatChanged() {
    state.lastKey = null;
    state.lastEmotion = null;
    clearSprite();
    updateHolderVariantSelect();
    refreshSettingsCharContext();
    const character = getActiveCharacter();
    if (character) await loadSprites(character.name, getCurrentVariant(), true);
    triggerClassify(true);
}

function wireEvents() {
    const c = getContext();
    const es = c.eventSource;
    const et = c.eventTypes;
    if (!es || !et) { console.warn(`[${MODULE_NAME}] eventSource unavailable`); return; }

    es.on(et.CHAT_CHANGED, onChatChanged);

    // An AI message finished rendering - the main trigger.
    es.on(et.CHARACTER_MESSAGE_RENDERED, () => triggerClassify());

    // Streaming replies don't emit CHARACTER_MESSAGE_RENDERED, so cover them here.
    // This fires after an AI generation, never when you send a message.
    es.on(et.GENERATION_ENDED, () => triggerClassify());

    // Swiping / editing, but only when the affected message is an AI message.
    es.on(et.MESSAGE_SWIPED, (id) => {
        if (settings().triggerOnSwipe && isAiMessage(id)) triggerClassify();
    });
    es.on(et.MESSAGE_EDITED, onAiMessageMutated);
    es.on(et.MESSAGE_UPDATED, onAiMessageMutated);

    // Deleting can change which message is last; the dedupe key decides if work is needed.
    es.on(et.MESSAGE_DELETED, () => triggerClassify());

    // Deliberately NOT hooked: MESSAGE_SENT and USER_MESSAGE_RENDERED.
    // Your own messages never trigger classification.
}

/** True if the message at this index exists and was written by the character (not you, not the system). */
function isAiMessage(mesId) {
    const chat = getContext().chat || [];
    const m = chat[Number(mesId)];
    return !!m && !m.is_user && !m.is_system;
}

function onAiMessageMutated(mesId) {
    if (settings().triggerOnEdit && isAiMessage(mesId)) triggerClassify();
}

// ------------------------------------------------------------------ //
// Slash commands
// ------------------------------------------------------------------ //
function registerSlashCommands() {
    const c = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandEnumValue, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser || !SlashCommand) return;

    const variantEnum = () => {
        const character = getActiveCharacter();
        if (!character) return [];
        return getVariantsFor(character.avatarKey).map(v => new SlashCommandEnumValue(v, 'variant'));
    };
    const labelEnum = () => libraryEntries().map(e => new SlashCommandEnumValue(e.label, e.isAction ? 'action' : 'emotion'));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-variant',
        helpString: 'Get or set the sticky Candy Expressions variant for this chat.',
        returns: 'the current variant',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'variant name to switch to (omit to read the current one)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            enumProvider: variantEnum,
        })],
        callback: async (_args, value) => {
            const name = String(value || '').trim();
            if (!name) return getCurrentVariant();
            const character = getActiveCharacter();
            const known = character ? getVariantsFor(character.avatarKey) : [];
            const match = known.find(v => v.toLowerCase() === name.toLowerCase()) || sanitizeVariantName(name);
            await switchVariant(match);
            return match;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-emote',
        helpString: 'Manually set the Candy Expressions sprite (label) right now (volatile).',
        returns: 'the label that was set',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'expression/action label',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: labelEnum,
        })],
        callback: async (_args, value) => {
            const label = sanitizeLabelName(value);
            const character = getActiveCharacter();
            if (!character || !label) return '';
            state.lastEmotion = label;
            await renderSprite(character.name, getCurrentVariant(), label);
            return label;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-classify',
        helpString: 'Classify text (or the last character message) with Candy Expressions and set the sprite.',
        returns: 'the classified label',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'text to classify (defaults to the last character message)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        callback: async (_args, value) => {
            const text = String(value || '').trim() || (getLastCharacterMessage()?.mes ?? '');
            if (!text) return '';
            return (await classifyText(text)) || '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-find',
        helpString: 'Reset the Candy Expressions sprite window to the bottom-left, make it visible, and flash it.',
        callback: async () => { locateHolder(); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-log',
        helpString: 'Show the Candy Expressions classification log: the exact prompt sent to the classifier and the raw reply.',
        callback: async () => { await showClassificationLog(); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'candy-refresh',
        helpString: 'Reload Candy Expressions sprites and re-classify the last message.',
        callback: async () => {
            const character = getActiveCharacter();
            if (character) await loadSprites(character.name, getCurrentVariant(), true);
            await renderSpriteGrid();
            triggerClassify(true);
            return '';
        },
    }));
}

// ------------------------------------------------------------------ //
// Bootstrap
// ------------------------------------------------------------------ //
jQuery(async () => {
    try {
        migrateSettings();
        ensureHolder();
        applyHolderChrome();
        injectSettingsPanel();
        addWandMenuEntry();
        setTimeout(addWandMenuEntry, 2000); // wand menu may build late
        addToolbarButton();
        registerSlashCommands();
        wireEvents();

        updateHolderVariantSelect();
        window.addEventListener('resize', clampHolderIntoView);

        const character = getActiveCharacter();
        if (character) {
            await loadSprites(character.name, getCurrentVariant(), true);
            triggerClassify(true);
        }
        console.log(`[${MODULE_NAME}] loaded`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] init failed`, err);
    }
});
