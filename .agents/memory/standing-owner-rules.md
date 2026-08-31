---
name: Standing owner rules (Book My Cleaning)
description: Non-negotiable habits the owner asked for by name — commit+push per task with a publish verdict, and a back-to-top affordance on long pages. Re-read after any restart.
---

# Commit and push after every task

Every task on this project ends with a commit **and** a push to the GitHub
remote, followed by a plain statement of whether the change needs publishing.
Not "at the end of the session", not "when there's enough to warrant it" — per
task. It covers the whole life of the project, first task to last, and binds
isolated task agents and subagents as much as the main agent; a rebuild does
not reset it. The step-by-step procedure lives at the top of `replit.md`, with
a signpost to it in root `AGENTS.md`, so a human or a fresh agent finds it
without reading memory; do not duplicate it here.

**Why:** the owner asked for it explicitly and repeated it after several tasks
merged without a push. Work that exists only in the workspace is invisible to
him and is lost if the workspace is rolled back or re-cloned. He also cannot
tell from a push whether bookmycleaning.net changed, so a task that ends
without a publish verdict leaves him guessing.

**How to apply:** after the verification pass of any task (including merged-in
task-agent work you touched), commit, push, state the publish verdict, and
offer the matching button.

# The GitHub repo and branch change on every rebuild

Never hardcode the remote URL, repo name, or branch in docs, scripts, or your
own reasoning. Read them from git each time
(`git remote get-url origin`, `git branch --show-current`).

**Why:** this project has been rebuilt repeatedly and the target repo changed
each time (a `Day5` repo became a `Day6` one, day-numbered branches gave way to
a named branch). Written-down names went stale silently, so "pushed" claims
pointed at a repo nobody was reading.

**How to apply:** treat git as the source of truth and any repo name written in
prose as a hint that may be stale. After `gitPush`, read the returned `remote`
and confirm `git rev-list --count @{u}..HEAD` is 0 — success alone is not proof
the push landed where you meant.

# Long pages need a way back to the top

Any page you can scroll should offer a one-click return to the top.

**Why:** the owner works long lists (a full day of bookings, a busy call log)
and got tired of dragging the scrollbar back up to reach the filters and the
primary buttons that live at the top of every page.

**How to apply:** the web dashboard shell renders a floating back-to-top button
once, for every page inside it. Keep new pages inside that shell. If a page
scrolls inside its own pane instead of the window, it needs its own equivalent
— the shell's button watches window scroll and will not notice an inner pane.
