# Decisions

This directory is the record of atmo's architectural decisions.

- **[map.md](map.md)** — every design decision the project has taken, with its
  current status and pointers to the full rationale. Start here.
- **`NNN-*.md`** — Architecture Decision Records (ADRs) for decisions made
  after the course (branches `a`–`k`) was frozen. Course-era decisions are
  argued in [the lessons](../learning/) and only _indexed_ here.

## When a decision needs an ADR

Write an ADR when the maintainer and the implementing agent choose between
real alternatives with lasting consequences: a dependency, a format, a
security posture, a public surface, a "why not X" that would otherwise be
re-litigated in six months. Do **not** write one for naming, mechanical
refactors, or bug fixes with one obvious shape — those are what code review
and git history are for.

## How to write one

1. Copy [000-template.md](000-template.md) to `NNN-short-kebab-title.md`,
   where `NNN` is the next unused three-digit number.
2. Keep it to roughly a page. Context states the alternatives that were
   actually considered; Decision is imperative; Consequences includes the
   honest costs.
3. Add or update the decision's row in [map.md](map.md) — see the rule below.

## Statuses

- `live` — current truth; code should conform to it.
- `superseded by NNN` — replaced; the pointed-to ADR wins.
- `amended by NNN` — still holds, but a later ADR adjusted its scope.

A status change edits the old ADR's **Status line only**. Bodies are never
rewritten — the same append-only ethos as the lessons, where
[lesson k](../learning/k-field-report.md) corrects earlier lessons without
touching them.

## The maintenance rule

> The map is maintained by hand. Every PR that adds an ADR also adds or
> updates that decision's row in `map.md` — same PR, no exceptions.
> Superseding an old decision means: new ADR, flip the old row's status to
> `superseded by NNN`, never edit the old ADR's body or any lesson.

An ADR PR without its map row is incomplete.

## Relation to the course

The lessons hold the deep rationale and are frozen. When a lesson's claim and
the map disagree, the map wins on _status_ and the lesson wins on _rationale
depth_ — read both. Lesson k is the worked example of supersession: it
corrects claims from lessons c, e, and f in place-of-editing style, and those
corrections are pre-marked in the map.
