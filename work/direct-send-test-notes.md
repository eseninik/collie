# Direct-send test evidence

Oracle: `collie-direct-send-brief.md`, owner's acceptance dated 2026-11-14.
The separate test author read public types and existing tests. The author did not read
implementation files or the implementation diff before writing these tests.

## New acceptance tests

- `bridge/surface/protocol.test.ts`: 16 initial direct-send cases. The base run exited 1:
  9 passed and 7 failed on the specified behavior. The failures were draft replacement
  for both profiles, bypassing an earlier hold for both profiles, Claude mismatch submit,
  and the two Codex submit retry cases.
- `bridge/surface/protocol.test.ts`: 9 additional cases for a modal or a missing box after
  typing, changed rows, another screen, and the Codex retry boundary. The base run exited 1:
  8 passed and the changed-rows case failed as specified.
- `bridge/surface/protocol.ghost-probe.test.ts`: one direct phone send on an unstyled
  Claude suggestion. This preserves the distinction between a suggestion and input.
- `web/src/components/composer-direct-send.test.tsx`: `@req:DS_UI @oracle:requirement`.
  The initial 13-case base run exited 1: 12 failed and the pi preservation case passed.
  Four later cases pin cap confirmation and image submission for both direct profiles.
  The expanded base run exited 1: 14 failed and 3 passed (both cap cases and pi).
  The unstyled-suggestion base run exited 0: 1 passed.

Base logs outside git:

- `/tmp/direct-send-tests-red-backend.log`
- `/tmp/direct-send-boundaries-base.log`
- `/tmp/direct-send-tests-red-web.log`
- `/tmp/direct-send-tests-red-web-expanded.log`
- `/tmp/direct-send-ghost-base.log`

All runs use `python3 /opt/codex-project-system/scripts/stand_run.py --here --short`.
The original backend command is `bun test bridge/surface/protocol.test.ts
--test-name-pattern 'direct phone send'`. The UI command is `bash -c 'cd web &&
bunx vitest run src/components/composer-direct-send.test.tsx'`.
The first six adapted UI files still passed on the base: 382 tests, exit 0,
`/tmp/direct-send-old-tests.log`.

## Existing tests changed

These tests keep the guarded behavior on a profile outside Claude/Codex. UI tests use pi.
The hold-release file uses a Claude-shaped test profile with id `hold-release-test`;
its queue behavior remains tested without claiming that direct profiles use that queue.
A helper change also affects tests that use it as a positive preview control.
The phone bare-Enter newline test now uses pi; direct profiles have new Enter tests.
No expectation was weakened. Commands keep their original Claude tests.

### web/src/components/composer-send-protocol.test.tsx

- a draft in the box offers Add, Replace and Cancel; Replace is a new request with a new id
- a draft refusal on a pane with a returned queued card points at that card, and keeps the offers (ADR 0122)
- Add to it sends the text after one space, so it does not run into the draft
- a screen Collie cannot read takes two taps: the second carries the rows hash
- typed but not submitted offers Submit and Discard, and keeps the draft

### web/src/components/composer-report.test.tsx

- three failed sends in a row float the card; Report opens the sheet with the streak's ids
- the cross closes it until a send works, and a held or draft refusal does not count

### web/src/components/composer.way-out.test.tsx

- composer draft: the placeholder stays plain, a send is refused at the thumb with Add, Replace and Cancel, and the way out stays
- modal unreadable: the placeholder stays plain, Send takes two taps (prepare, then commit with the rows seen), and the Keys dock is enabled

### web/src/components/composer-offline.test.tsx

- waits while the terminal-draft notice holds the slot, then shows when it is dismissed

### web/src/components/composer-held.test.tsx

- with the terminal-draft notice also due, both float in one column: the held card first, the notice nearest the belt

### web/src/components/composer.test.tsx

- never writes the draft into the input across appear → stabilise → live typing → vanish
- leaves the user's own typed text intact while a draft appears, streams, and vanishes
- appears only after the draft stabilises — a raw-only blip never flashes it
- tracks the raw draft live once shown — host typing streams into the preview text
- unmounts when the raw draft goes null (submitted or cleared on the host)
- floats out of the flow: absolutely positioned, never a row of the composer
- portals into the slot it is handed, and nowhere inside the composer
- the x hides it, and editing the host draft keeps it hidden
- comes back for the next draft once the dismissed one is gone
- Take over still works from the floating notice
- persists across subsequent polls of the same text with no user action
- Take over copies the CURRENT draft into the composer, marks it handled, and hides the preview
- after Take over, a divergent host draft honestly re-shows the preview with the new text
- re-stranding the SAME text after the line cleared is a fresh draft — the preview returns
- send after Take over meets the host line at the bridge: Replace overwrites it, and no key leaves the phone
- read-only device: shows the preview and allows Take over (local copy), writing nothing to the terminal
- a terminal draft alone (preview only, empty input) does NOT hold — it re-derives after a reload
- suppresses the chip AND skips the clear-prefix when the draft matches what we just sent
- still treats a genuinely different stranded draft as real (previews it; Take over + Send goes to the bridge)
- hides its own staged photo path for the whole send, and stays quiet after
- hides even a foreign draft while the send is in flight
- refused draft_present: Add to it, Replace and Cancel, with the draft kept
- typed_not_submitted: Submit and Discard are new requests with new ids, and the draft is kept
- typed_not_submitted %s with no frame: Submit and Discard show, and Submit carries the rows hash it was offered with [mismatch, changed, modal_cue, stale_token, submit_failed, dialog_open, unreadable]
- typed_not_submitted with no frame: Discard carries the rows hash it was offered with
- still sends on Ctrl+Enter, and still leaves a bare Enter to the textarea

### bridge/surface/protocol.inturn-release.test.ts

- a turn over an empty box reads running, no modal, empty; the dialog reads not free; the ended turn reads free
- a fresh phone send into the running turn takes the queued path (Collie's own send path supports it)
- INTURN-1 a held phone send goes out while the turn still runs, on two in-turn free polls, by the queued path
- INTURN-1 a phone send held behind it in the same turn goes too, in order, without the turn ending
- INTURN-2 one in-turn free poll is not enough, and a poll with something open at the box between them starts the count again
- INTURN-3 a held send that is not a person's phone send (walky talky, CLI) waits for the turn to end
- INTURN-4 a held phone command (mode command, text `/compact`) waits for the turn to end
- INTURN-4 a phone text that starts with `/` in mode send is never held: refused reserved_lead before any key
- INTURN-5 a non-direct Claude-shaped profile with a version Collie could not read: a held phone send waits for the turn to end
- INTURN-5 a profile whose harness takes nothing in a turn (no `queues`, no queue key): a held phone send waits for the turn to end
- INTURN-6 in-turn releases that meet a dialog at S0 press nothing, go back held, spend no tries; after the turn it is sent
- INTURN-7 a marked send held over a draft keeps its own rules: not released into the turn the draft started
- INTURN-8 in-turn releases that keep failing at S0 stop after exactly 8 (IN_TURN_RELEASES), spend no tries, and it goes after the turn
- INTURN-9 a phone send behind a head that may not go into a turn [a send without fromPhone; a phone command] goes into the turn ahead of it; the head goes after the turn
- INTURN-10 after a bridge restart (a new HoldStore and SendProtocol over the same directory) the held phone send goes into the turn
- INTURN-10 a held file written without the intoTurn field (an old entry) waits for the turn to end after the restart
- INTURN-11 a person's sends keep their order: B never goes into the turn ahead of A once A's in-turn releases are spent
- INTURN-12 an in-turn release whose submit key does not take ends with its own outcome, not held again; the phone send behind it waits while the box holds that text


### More confirmed obsolete assertions from the first full run

`web/src/components/composer.test.tsx` now uses pi for these old guarded paths:

- keeps the draft and offers Submit or Discard when the text was typed and not submitted
- composer draft: the bridge refuses draft_present and the strip offers Add, Replace and Cancel
- modal unreadable: two taps, nothing typed on the first, the second commits the rows the person saw
- unknown (no-match): the probed Send, two taps, with no card to go to
- says why at the thumb when the bridge cannot read the screen, and its control goes to the card
- an unreadable screen with no dialog card: the sentence once, no Answer the dialog, and a ✕ that hides the notice
- the offers' ✕ hides the notice with the strip
- every closed outcome and reason lands at the thumb, and none of them puts an action in the header

- under the cap the manual Send is two taps, and no commit carries a cap ack
- at the cap the commit is refused once more with the count and the version, and the next tap carries the ack
- a harness with no version is named alone in the cap's notice, not as `agent -`
- the cap never removes the manual Send or the Keys dock
- dismissing the notice and tapping Send again starts over from the first tap, with no ack held

`web/src/components/agent-chat.test.tsx` now uses a pi agent and a pi input frame:

- renders in the mirror's own slot, never in the bottom region
- the x hides it without moving anything into the flow

`bridge/surface/route.test.ts` now uses a slash command to keep a genuine draft refusal:

- a refused send lists the detail and saw its answer had; a sent one lists neither

New safety cases in the public-contract tests preserve idempotent retries after a lost
Replace answer. They also forbid recovery offers at a hard stop and forbid client
Submit when a legacy reply identifies another screen or no input box.

## Final test inventory and fixture checks

New acceptance cases: 31 backend and 23 UI.
The backend count includes 3 hard-stop reply cases that forbid Submit/Replace offers.
The UI count includes 6 later safety cases: lost Replace answer idempotency,
other-screen legacy replies, and no-input-box legacy replies, on both direct profiles.
These safety tests were written before their implementation fix, from the public
idempotent request contract and the brief's hard stops.

The adapted hold-release suite passed on the base: 19 passed, exit 0,
`/tmp/direct-send-inturn-adapted-base.log`.
The AgentChat preview fixture uses `pi--v0851-draft.txt`, the same styled capture
already proven by `harness/pi/composer.test.ts`. Only its draft text is changed.
Two earlier fixture checks failed (synthetic unstyled frame, then a jsdom URL scheme).
The final narrow check passed: 2 passed, exit 0,
`/tmp/direct-send-agent-chat-pi-capture-valid-base.log`.
These fixture corrections keep both preview assertions intact.

Existing changed tests: 78 expanded cases (including the seven-reason recovery
parameterization and the two-head hold-release parameterization), across 9 files.
The full title list above is authoritative; grouped helper lists include their
positive and negative controls.

## Profile and multiline preservation

Two later public-seam tests pin the brief's scope without implementation access:

- A phone send to a bare shell without a profile still submits normally.
- A direct Claude phone message replaces its terminal draft when the first line
  is ordinary text and a later line starts with `/model`; the full body is sent.

The narrow base proof is `/tmp/direct-send-profile-multiline-base.log`.
