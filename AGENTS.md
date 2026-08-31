# Read this before you touch anything

This file exists for one reason: so that no agent, on any rebuild of this
project, can start work without seeing the owner's standing rule.

## The rule

**Every task ends with a commit and a push, and a plain statement of whether
the change needs publishing.**

It applies:

- from the very first task on this project to the very last;
- to every agent and every person — the main agent, isolated task agents,
  subagents, and any human contributor;
- to every task, however small — a one-line copy fix ends the same way a new
  feature does;
- after every rebuild of the workspace. A fresh environment does not reset
  this. If you are reading this file for the first time, the rule is already
  in force.

It does not expire, and it is not something to batch up "until there's enough
to be worth pushing". Work that lives only in the workspace is invisible to
the owner and is lost the moment the workspace is rolled back or re-cloned.

## The procedure

The full step-by-step — the exact commands, why `gitPush` is required instead
of `git push`, how to check where the push actually landed, and how to word
the publish verdict — is at the top of [`replit.md`](replit.md) under
**"How every task ends (non-negotiable)"**.

Read it there rather than working from memory. It is kept current; this file
is only the signpost.

## Everything else

`replit.md` is also the project overview: what the product is, how the Quo and
Jobber integrations work, the architecture, and the owner's other standing
preferences.
