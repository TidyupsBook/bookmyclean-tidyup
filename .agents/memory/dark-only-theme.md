---
name: Dark-only theme — `dark:` variants never fire
description: The dashboard's dark palette lives on :root; the `.dark` class is never applied, so Tailwind `dark:` variants are dead code and light-mode fallbacks actually render.
---

The web dashboard is dark-only: the dark palette is defined on `:root` in
`index.css` and nothing ever adds the `.dark` class to the document.

**Why:** Any `dark:` Tailwind variant silently never fires — the *light*-mode
class renders instead, on a dark page. This shipped a real bug: a call-filled
field highlight of `bg-emerald-50 dark:bg-emerald-950/40` painted near-white
green behind white text, making auto-filled numbers invisible until selected.

**How to apply:** When adding color utilities in the dashboard, pick colors for
the dark palette outright (e.g. `bg-emerald-500/15`) and never write `dark:`
variants — if one shows up in a diff or a pasted snippet, it's a smell that the
light-mode half is what will actually render. A pinned test on the highlight
rule now rejects `dark:` and light-mode emerald there.
