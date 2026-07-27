# Candy Expressions

A two-dimensional character-expression extension for **SillyTavern**.

The built-in *Character Expressions* extension is one-dimensional: `emotion → sprite`.
Candy Expressions adds a second axis:

```
variant  ×  emotion/action  →  sprite
```

* **variant** — the character's outfit / form / state (e.g. `default`, `armor`, `alien`). **Sticky:** it stays put until you change it, and it is saved **per chat**.
* **emotion / action** — the facial expression *or* a physical action (e.g. `joy`, `anger`, `charging`, `fighting`). **Volatile:** re-classified on every character message.

| | emotion / action | variant |
|---|---|---|
| Re-evaluated | every message | only when you switch it |
| Behavior | volatile | **sticky** |
| Stored in | ephemeral memory | `chatMetadata` (per chat) |

Sprites reuse SillyTavern's own character sprite storage, one subfolder per variant:

```
characters/<Character>/default/joy.png     characters/<Character>/default/anger.png
characters/<Character>/armor/joy.png       characters/<Character>/armor/charging.png
characters/<Character>/alien/joy.png
```

---

## Installation

1. In SillyTavern: **Extensions → Install extension**.
2. Paste this repository URL:
   `https://github.com/CountCandy/SillyTavern-Extension-CandyExpressions`
3. Reload SillyTavern.
4. **Disable the built-in "Character Expressions" extension** (Extensions panel) so you don't get two sprite windows fighting over the screen.

> This is a UI extension — no server plugin. It talks to SillyTavern only through `SillyTavern.getContext()`, so it doesn't care what folder name it's installed under.

---

## How it works

### Variants (sticky, manual)

* A small **variant dropdown** sits on the in-chat sprite window.
* You can also switch from the **wand menu → "Candy: Switch Variant"**, or with `/candy-variant`.
* The chosen variant is written to the chat's metadata, so re-opening the chat restores it. Different chats can sit in different variants.
* Variant switching **does not** call the model — it just swaps which sprite folder is used.

### Emotions & actions (volatile, classified)

After each character message, the message text is sent to the **main chat API** for classification. Two things make this different from a normal reply:

* It uses **its own system prompt** — never the roleplay system prompt or the chat history. (Under the hood it uses `generateRaw` with a dedicated `systemPrompt`.)
* The model is asked to answer with exactly one label from your library.

**Actions** are just labels with a description. Give an action a good description and the classifier knows when to pick it:

```
charging: Winding up or rushing forward to launch a physical attack.
fighting: Actively trading blows in close combat right now.
jumping:  Leaping or already airborne after a jump.
```

Emotions and actions share one library (used for every character). Which of them are actually *offered* for a given character/variant can be narrowed to just the ones that have a sprite (see **Filter available**).

### Thinking / reasoning models

Built for reasoning-capable classifiers (e.g. Gemma-class models). The classifier prompt invites the model to reason inside `<think>…</think>`, and that block is stripped before the label is parsed. If your model uses different delimiters, change **Think open / Think close** in the settings. As a safety net the parser also:

* understands JSON answers like `{"label":"joy"}`,
* scans from the **end** of the output (so leftover reasoning that mentions other labels doesn't fool it),
* falls back to fuzzy/substring matching, then to your fallback label.

---

## Managing variants & sprites

Open **Extensions → Candy Expressions**. With a single-character chat open you get:

* **Add variant(s)** — type one or more names (comma-separated, e.g. `armor, suit, alien`). Each becomes a sprite subfolder.
* **Variant tabs** — pick which variant you're editing.
* **Sprite grid** — every label in your library shown as a tile. Click **upload** on a tile to set that label's sprite, or **trash** to delete it. A `*` after a label means a sprite file exists that isn't in your library yet.
* **Batch upload (ZIP)** — drop in a ZIP of images; **each image's file name becomes its label** (`charging.png` → `charging`). The fastest way to fill a whole variant at once.
* **Refresh** — reload sprites from disk.

### Adding expressions in bulk

In the **Expression Library** section:

* **Add** — one label with a description and an "is an action" flag.
* **Bulk add** — paste many at once, one per line, `label: description` (description optional):

  ```
  charging: rushing forward to attack
  smug
  jumping: leaping into the air
  ```

---

## Settings

| Setting | What it does |
|---|---|
| Enable automatic classification | Master switch for per-message emotion classification. |
| Show in-chat sprite window | Show/hide the floating sprite. Drag it by the grip; position is remembered. |
| Chromeless window | Hide the sprite window's frame/background. |
| Only offer labels that have a sprite | Restrict the classifier to labels that actually have a sprite in the active variant. |
| Borrow a missing sprite from the default variant | If a variant lacks a sprite for the chosen label, fall back to the `default` variant. |
| Show an emoji when no sprite is found | Last-resort emoji instead of a blank window. |
| Classifier prompt | The system prompt. Macros: `{{labels}}`, `{{descriptions}}`, `{{fallback}}`, `{{thinking}}`. |
| Classifier may &lt;think&gt; | Allow reasoning and strip it. Configure the delimiters. |
| Fallback label | Used when nothing else matches. |

---

## Slash commands

| Command | Description |
|---|---|
| `/candy-variant [name]` | Get the current variant, or switch to `name` (sticky, saved per chat). |
| `/candy-emote <label>` | Manually set the sprite right now (volatile — the next message may change it). |
| `/candy-classify [text]` | Classify `text` (or the last character message) and set the sprite. Returns the label. |
| `/candy-refresh` | Reload sprites and re-classify the last message. |

---

## Notes & limitations

* **Group chats:** basic support — the extension follows the last character who spoke and uses that chat's variant. Per-member variants and Visual Novel mode are not handled yet.
* Removing a variant only removes it from the list; the sprite files on disk are left alone.
* Classification runs on the model connected as your **main API**, so it consumes a request per character message.

---

## License

Code is licensed under **Apache-2.0** (see `LICENSE`). Sprites you add and any models you connect are yours and are governed by their own terms.
