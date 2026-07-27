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

* A **variant button** sits in the toolbar next to the chat input (🎭 + the current variant name). Click it for a large, easy-to-hit picker.
* You can also switch from the **wand menu → "Candy: Switch Variant"**, or with `/candy-variant`.
* The sprite window shows the current variant name, but isn't clickable — so you can't knock it out of variant by accident.
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

The classifier is told to **reason first, then answer** — which measurably improves consistency, especially for action labels. It ends its reply with:

```
ANSWER: excitement
```

That marker is what gets parsed, so **the reasoning format doesn't matter**. Whether your model emits `<think>…</think>`, `<|channel|>analysis`, `<|channel>thought`, or nothing at all, the answer is still read correctly. Stripped automatically: `<think>`, `<thinking>`, `<reasoning>`, `<reflection>`, `<scratchpad>`, and channel/harmony control tags. The **Think open / close** boxes are only needed for genuinely unusual formats.

Fallbacks, in order: `ANSWER:` line → JSON (`{"label":"joy"}`) → last matching word in the reply → substring match → your fallback label. Scanning from the *end* means reasoning that mentions other labels along the way doesn't fool it.

### Consistency

**Deterministic classification** (on by default) forces greedy sampling — temperature 0, top_k 1, no stop strings — *for classification requests only*. Your roleplay preset is untouched.

This matters a lot: without it, classification inherits your RP preset's temperature and top_p, so the *same message can classify differently every time*. Roleplay stop-strings can also truncate the reply before the answer line, which is why they're cleared too.

**Reply token budget** (default 256) gives reasoning room to finish. If replies look cut off mid-thought, raise it.

---

## Verifying what the classifier actually sees

Because classification shares your main API connection, you may reasonably want proof that your **roleplay** system prompt, persona, and chat history aren't leaking into it. There's a built-in audit trail.

**Extensions → Candy Expressions → Classifier → View classification log** (or the `/candy-log` command).

Each entry records one classification round-trip:

| Block | What it shows |
|---|---|
| Labels offered | Exactly which labels the model could choose from |
| **System prompt** | The complete instruction text sent — the *only* instructions sent |
| **User message** | The complete content sent — just the character's line |
| **Raw model reply** | What came back verbatim, `<think>` blocks and all |

If your roleplay prompt, persona, character card, or prior messages don't appear in those blocks, they weren't sent. Tick **"Also log every classification to the browser console"** to get the same dump in the F12 console as it happens.

Two extra ways to cross-check:

* Watch your backend's own log (llama.cpp / Ollama / TabbyAPI all print the incoming prompt). It should match the log entry exactly.
* Temporarily set your classifier prompt to something distinctive like `Reply with only the word: banana`. If the reply is `banana`, nothing else is steering the model.

Under the hood this uses SillyTavern's `generateRaw()` with an explicit `systemPrompt`, which builds a standalone prompt rather than the chat-generation pipeline — no character card, no persona, no history.

---

## Managing variants & sprites

Open **Extensions → Candy Expressions**. With a single-character chat open you get:

* **Add variant(s)** — type one or more names (comma-separated, e.g. `armor, suit, alien`). Each becomes a sprite subfolder.
* **Variant tabs** — pick which variant you're editing. Sorted A→Z.
* **Sprite grid** — every label as a tile, sorted A→Z with emotions and actions mixed together (actions are tinted orange). Click **upload** on a tile to set that label's sprite, **trash** to delete it, or the **thumbnail** to preview it in the chat window. A `*` marks a sprite whose label isn't in your library yet; a number badge shows how many sprites a label has.
* **Batch upload images** — select **many images at once**; each is filed automatically by its name:

  | file | lands under |
  |---|---|
  | `anger.png` | `anger` |
  | `anger-0003.png` | `anger` |
  | `anger.smug.png` | `anger` |

  (Same rule SillyTavern itself uses: everything before the first `-` or `.` suffix.) Extra sprites for one label are all kept, and one is picked at random each time that expression fires. If any uploaded label isn't in your library, you're offered a one-click way to add them.
* **ZIP** — SillyTavern's own ZIP endpoint. It's known to stall on some archives, so it's the fallback here, not the default; it now times out after 60s with a clear message instead of spinning on "Uploading…" forever.
* **Delete all sprites** — wipes every sprite file in the selected variant (with a confirmation showing the exact count).
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
| Make the classifier reason first | Ask for short reasoning before the `ANSWER:` line. Recommended. |
| Deterministic classification | Force temperature 0 / top_k 1 for classification only, so results are repeatable. |
| Warn when a label has no sprite | Toast when a classified label has no image, instead of failing silently. |
| Reply token budget | Room for reasoning + the answer line (default 256). |
| Fallback label | Used when nothing else matches. |
| Test classifier | Classify the last message now and report the label **and** whether a sprite was found. |
| View classification log | The exact prompt/reply audit trail (last 25 classifications). |
| Log to browser console | Mirror every classification into the F12 console as it happens. |

---

## Slash commands

| Command | Description |
|---|---|
| `/candy-variant [name]` | Get the current variant, or switch to `name` (sticky, saved per chat). |
| `/candy-emote <label>` | Manually set the sprite right now (volatile — the next message may change it). |
| `/candy-classify [text]` | Classify `text` (or the last character message) and set the sprite. Returns the label. |
| `/candy-log` | Open the classification log (exact prompt sent + raw reply). |
| `/candy-refresh` | Reload sprites and re-classify the last message. |

---

## Troubleshooting

**A label is chosen but no sprite appears.** That's the most common cause of "nothing happens": the classification worked, but that variant has no image for the chosen label. The log marks these entries **NO SPRITE**, and you get a toast (once per label per variant). Fix it by uploading `<label>.png` to that variant, turning on *Borrow a missing sprite from the default variant*, or enabling the emoji fallback. **Test classifier** tells you which of the two happened in one click.

**The same message keeps giving different answers.** Turn on *Deterministic classification*. Your roleplay preset's temperature is otherwise randomising the result.

**Answers look truncated or the label is missing.** Raise the *Reply token budget*; reasoning models can spend a lot of it thinking.

**Nothing classifies at all.** Check *Enable automatic classification* is ticked, then hit **Test classifier** — it reports the exact failure.

---

## Notes & limitations

* **Group chats:** basic support — the extension follows the last character who spoke and uses that chat's variant. Per-member variants and Visual Novel mode are not handled yet.
* Removing a variant only removes it from the list; the sprite files on disk are left alone.
* Classification runs on the model connected as your **main API**, so it consumes a request per character message.

---

## License

Code is licensed under **Apache-2.0** (see `LICENSE`). Sprites you add and any models you connect are yours and are governed by their own terms.
