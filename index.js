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

const DEFAULT_CLASSIFY_PROMPT = `You are an expression classifier for a visual-novel engine. You will be shown the most recent line said or narrated for a single character. Pick the ONE label from the list that best matches that character's current facial expression, emotion, or physical action.

Available labels:
{{labels}}
{{descriptions}}
Rules:
- Reply with exactly one label from the list above and nothing else.
- Choose an action label only when the text clearly shows that physical action happening now; otherwise choose the closest emotion.
- If nothing fits, choose "{{fallback}}".
- Output the label in lowercase, with no quotes, punctuation, or extra words.
{{thinking}}`;

// Optional emoji fallback for the default emotions (used only if enabled and no sprite exists).
const EMOJI_FALLBACK = {
    admiration: '😍', amusement: '😄', anger: '😡', annoyance: '😒', approval: '👍',
    caring: '🤗', confusion: '😕', curiosity: '🤔', desire: '😏', disappointment: '😞',
    disapproval: '👎', disgust: '🤢', embarrassment: '😳', excitement: '🤩', fear: '😨',
    gratitude: '🙏', grief: '😭', joy: '😊', love: '❤️', nervousness: '😬', optimism: '🙂',
    pride: '😌', realization: '💡', relief: '😅', remorse: '😔', sadness: '😢',
    surprise: '😲', neutral: '😐',
};

const DEFAULT_SETTINGS = {
    version: 1,
    enabled: true,
    // classifier
    classifyPrompt: DEFAULT_CLASSIFY_PROMPT,
    filterAvailable: true,       // only offer labels that have a sprite in the active variant
    thinkingEnabled: true,       // allow the classifier model to "think" then strip it
    thinkPrefix: '<think>',
    thinkSuffix: '</think>',
    maxSampleChars: 1400,        // trim very long messages before classifying
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
    saveSettings();
}

/** All library labels, tagged with isAction. */
function libraryEntries() {
    const s = settings();
    return [
        ...s.emotions.map(e => ({ label: e.label, description: e.description || '', isAction: false })),
        ...s.actions.map(a => ({ label: a.label, description: a.description || '', isAction: true })),
    ];
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

/** Registered variants for a character (always includes the default variant, default first). */
function getVariantsFor(avatarKey) {
    const s = settings();
    const rec = s.characters[avatarKey];
    const list = Array.isArray(rec?.variants) ? rec.variants.slice() : [];
    const def = s.defaultVariant || DEFAULT_VARIANT;
    if (!list.includes(def)) list.unshift(def);
    return list;
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

async function uploadSpriteZip(charName, variant, file) {
    const folder = spriteFolder(charName, variant);
    const form = new FormData();
    form.append('name', folder);
    form.append('avatar', file);
    const res = await fetch('/api/sprites/upload-zip', {
        method: 'POST',
        headers: getContext().getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
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
    const thinking = s.thinkingEnabled
        ? `\nYou may reason privately first. Put any reasoning between ${s.thinkPrefix} and ${s.thinkSuffix}. After ${s.thinkSuffix}, output only the final label.`
        : '';
    return String(s.classifyPrompt)
        .replace(/{{labels}}/g, labels.join(', '))
        .replace(/{{descriptions}}/g, descBlock)
        .replace(/{{thinking}}/g, thinking)
        .replace(/{{fallback}}/g, s.fallbackExpression || 'neutral');
}

/** Remove <think>...</think> style blocks using the configured delimiters. */
function stripThinking(text) {
    const s = settings();
    let out = String(text || '');
    if (s.thinkPrefix && s.thinkSuffix) {
        const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            const re = new RegExp(`${esc(s.thinkPrefix)}[\\s\\S]*?${esc(s.thinkSuffix)}`, 'g');
            out = out.replace(re, ' ');
        } catch { /* ignore bad regex */ }
    }
    // As a fallback, also lean on SillyTavern's own reasoning parser if present.
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

    let raw = '';
    try {
        // Main chat API, but with OUR system prompt only (no roleplay prompt, no chat history).
        raw = await getContext().generateRaw({ prompt: sampled, systemPrompt });
    } catch (err) {
        console.error(`[${MODULE_NAME}] Classification request failed`, err);
        if (typeof toastr !== 'undefined') {
            toastr.error('Candy Expressions could not reach the classifier. Is an API connected?', 'Classification failed');
        }
        return null;
    }

    const label = parseLabel(raw, labels, s.fallbackExpression);
    state.lastEmotion = label;
    if (render) await renderSprite(character.name, variant, label);
    return label;
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
    holder.innerHTML = `
        <div class="candy-holder-header">
            <div class="candy-drag-grabber fa-solid fa-grip" title="Drag to move"></div>
            <select class="candy-variant-select" title="Variant (sticky, saved per chat)"></select>
            <div class="candy-holder-btn candy-open-settings fa-solid fa-gear" title="Manage Candy Expressions"></div>
        </div>
        <img id="candy-expression-image" alt="" draggable="false">
        <div class="candy-emoji-fallback" style="display:none;"></div>`;
    document.body.appendChild(holder);

    // restore saved position
    const pos = settings().holder;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        holder.style.left = `${pos.x}px`;
        holder.style.top = `${pos.y}px`;
        holder.style.bottom = 'auto';
    }

    holder.querySelector('.candy-variant-select').addEventListener('change', onHolderVariantChange);
    holder.querySelector('.candy-open-settings').addEventListener('click', openSettingsPanel);
    makeDraggable(holder, holder.querySelector('.candy-drag-grabber'));
    applyHolderChrome();
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

async function renderSprite(charName, variant, label) {
    if (!settings().showSpriteWindow) return;
    ensureHolder();
    updateHolderVariantSelect();

    const img = document.getElementById('candy-expression-image');
    const emoji = document.querySelector('#candy-expression-holder .candy-emoji-fallback');
    if (!img) return;

    const file = await resolveSprite(charName, variant, label);
    if (file) {
        img.src = file.url;
        img.style.display = '';
        img.title = label;
        if (emoji) emoji.style.display = 'none';
    } else if (settings().showEmojiFallback && EMOJI_FALLBACK[label]) {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (emoji) { emoji.textContent = EMOJI_FALLBACK[label]; emoji.style.display = ''; }
    } else {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (emoji) emoji.style.display = 'none';
    }
}

function clearSprite() {
    const img = document.getElementById('candy-expression-image');
    const emoji = document.querySelector('#candy-expression-holder .candy-emoji-fallback');
    if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
    if (emoji) emoji.style.display = 'none';
}

// ------------------------------------------------------------------ //
// In-chat variant selector (on the holder) + wand-menu quick switch
// ------------------------------------------------------------------ //
function updateHolderVariantSelect() {
    const select = document.querySelector('#candy-expression-holder .candy-variant-select');
    if (!select) return;
    const character = getActiveCharacter();
    const variants = character ? getVariantsFor(character.avatarKey) : [settings().defaultVariant];
    const current = getCurrentVariant();
    select.innerHTML = variants.map(v =>
        `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

async function onHolderVariantChange(e) {
    await switchVariant(e.target.value);
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
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const v of variants) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (v === current) opt.selected = true;
        select.appendChild(opt);
    }
    // Apply immediately on change (robust: no reliance on reading DOM after teardown).
    select.addEventListener('change', () => { switchVariant(select.value); });
    wrap.append(title, hint, select);

    const popup = new c.Popup(wrap, c.POPUP_TYPE.TEXT, '', { okButton: 'Close', allowVerticalScrolling: true });
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

            <div class="candy-section">
                <div class="candy-section-title"><span>Classifier</span></div>
                <small>Runs on the main chat API, but with this system prompt only — never the roleplay prompt or chat history. Macros: <tt>{{labels}}</tt>, <tt>{{descriptions}}</tt>, <tt>{{fallback}}</tt>, <tt>{{thinking}}</tt>.</small>
                <textarea id="candy-prompt" class="text_pole textarea_compact" rows="8" placeholder="Classification system prompt"></textarea>
                <div class="candy-row">
                    <div class="menu_button" id="candy-prompt-reset"><i class="fa-solid fa-clock-rotate-left"></i> Reset to default</div>
                </div>
                <label class="checkbox_label" for="candy-thinking"><input type="checkbox" id="candy-thinking"><span>Classifier may &lt;think&gt; first (reasoning is stripped before parsing)</span></label>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Think open<br><input id="candy-think-prefix" class="text_pole" type="text"></label>
                    <label class="candy-grow">Think close<br><input id="candy-think-suffix" class="text_pole" type="text"></label>
                </div>
                <div class="candy-row nowrap">
                    <label class="candy-grow">Fallback label<br><select id="candy-fallback" class="text_pole"></select></label>
                </div>
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
                    <span class="menu_button" id="candy-zip-upload" title="Each image's file name becomes its label"><i class="fa-solid fa-file-zipper"></i> Batch upload ZIP</span>
                    <span class="menu_button" id="candy-refresh-sprites"><i class="fa-solid fa-rotate"></i> Refresh</span>
                    <span class="menu_button candy-danger" id="candy-delete-variant"><i class="fa-solid fa-trash-can"></i> Remove variant</span>
                </div>
                <div class="candy-sprite-grid" id="candy-sprite-grid"></div>
                <p class="candy-hint">Tip: sprites live in <tt>/characters/&lt;name&gt;/&lt;variant&gt;/&lt;label&gt;.png</tt>. A <tt>*</tt> after a label means a sprite exists that isn't in your library.</p>
            </div>
        </div>
    </div>
    <input type="file" id="candy-file-input" accept="image/*" hidden>
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
    $id('candy-zip-upload')?.addEventListener('click', () => $id('candy-zip-input')?.click());
    $id('candy-variant-tabs')?.addEventListener('click', onVariantTabClick);
    $id('candy-sprite-grid')?.addEventListener('click', onSpriteGridClick);
    $id('candy-file-input')?.addEventListener('change', onSpriteFileChosen);
    $id('candy-zip-input')?.addEventListener('change', onZipChosen);

    renderLabelList();
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
    const extraLabels = [...new Set(sprites.map(s => s.label))].filter(l => !libLabels.has(l));

    const tile = (label, isAction, files, isExtra) => {
        const file = files && files.length ? files[0] : null;
        return `
        <div class="candy-sprite-tile ${file ? '' : 'candy-missing'}" data-label="${escapeHtml(label)}">
            ${file
                ? `<img class="candy-sprite-thumb" src="${file.url}" title="${escapeHtml(label)}" data-file="${escapeHtml(file.fileName)}">`
                : '<div class="candy-sprite-thumb candy-placeholder"><i class="fa-solid fa-image"></i></div>'}
            <div class="candy-sprite-label ${isAction ? 'candy-is-action' : ''}">${escapeHtml(label)}${isExtra ? ' *' : ''}</div>
            <div class="candy-sprite-actions">
                <span class="candy-mini-btn fa-solid fa-upload candy-upload-sprite" title="Upload sprite"></span>
                ${file ? `<span class="candy-mini-btn fa-solid fa-trash-can candy-danger candy-del-sprite" title="Delete sprite" data-file="${escapeHtml(file.fileName)}"></span>` : ''}
            </div>
        </div>`;
    };

    const tiles = entries.map(e => tile(e.label, e.isAction, byLabel[e.label], false));
    for (const l of extraLabels) tiles.push(tile(l, false, byLabel[l], true));
    grid.innerHTML = tiles.join('');
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
        toastr?.error('ZIP upload failed.', 'Candy Expressions');
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
    es.on(et.CHARACTER_MESSAGE_RENDERED, () => triggerClassify());
    es.on(et.GENERATION_ENDED, () => triggerClassify());
    es.on(et.MESSAGE_SWIPED, () => triggerClassify());
    es.on(et.MESSAGE_EDITED, () => triggerClassify());
    es.on(et.MESSAGE_UPDATED, () => triggerClassify());
    es.on(et.MESSAGE_DELETED, () => triggerClassify());
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
        registerSlashCommands();
        wireEvents();

        updateHolderVariantSelect();
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
