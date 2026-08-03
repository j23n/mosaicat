# 001: ADRs, a decision map, and a frozen course

- **Status:** live
- **Date:** 2026-08-03
- **Supersedes:** —

## Context

The course (branches `a`–`k`) is merged to `main` and development now happens
in maintainer-plus-agent sessions. The project's ~60 design decisions live in
eleven course-shaped lesson files and twenty module-header comments — deep,
but scattered, and deliberately append-only: lesson k corrects claims in
lessons c, e, and f that remain wrong in place. An agent picking up feature
work had no entry point, no index of which decisions are still live, and no
defined way to record the decisions taken in a session. Alternatives
considered: keep writing a lesson per feature (richest record, highest cost);
a single running decision-log file (cheap, but nuance-free); full retroactive
ADR extraction (~60 files duplicating lesson prose).

## Decision

Freeze the course as a finished artifact and develop by normal branches and
PRs from `main`. Record each real maintainer-plus-agent decision as a
lightweight ADR in this directory, and maintain `map.md` by hand as the index
of every decision — course-era rows pointing into the lessons, post-course
rows pointing at ADRs. `AGENTS.md` at the repo root is the canonical agent
entry point; `CLAUDE.md` is an import shim so Claude Code loads it
automatically.

## Consequences

Every decision now touches two files (its ADR and its map row) — accepted
cost, enforced by the same-PR rule in [README.md](README.md). The map is the
single failure point: if it drifts from the ADRs or the code, agents will act
on stale truth, which is exactly the silent-degradation failure mode lesson k
documents. Lessons stay quotable and internally consistent as a course, at
the price that reading one in isolation can mislead — the map's status column
is the antidote.
