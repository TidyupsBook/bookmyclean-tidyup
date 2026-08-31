---
name: In-app notifications for crew chat
description: Why staff chat deliberately texts nobody, and the rules any unread badge/sound must follow.
---

# Crew chat notifies in the app, never by text

Posting to staff chat must not send SMS to members who aren't reading.

**Why:** every line of a quick back-and-forth became a text to every absent
member — noise on the crew's phones and a real Quo bill. The owner asked for
"red like Messenger" instead. The one text this area still sends is the receipt
for a reply that arrived *by* text; dropping that would leave the sender
thinking nobody received it.

**How to apply:** if a future change wants to "just nudge them," the answer is
push notifications (expo-notifications + device tokens + server push), not
re-adding SMS. The known gap is deliberate: with texts off, a cleaner only
learns about a message while the app is open.

## Rules for any unread badge or sound

- **One tally, one source.** Badge and chime must read the same query keys, and
  exactly one mounted component should own the `refetchInterval` for a given
  key — two owners means two timers, two answers, and a badge that disagrees
  with the sound.
- **Never fire on the first tally.** A backlog on sign-in is a starting point,
  not an arrival. Baseline silently, then sound only on a rise.
- **Baseline is per identity.** Endpoint query keys carry no account, so
  switching person or company hands the watcher a different backlog; key the
  remembered tally to the user/company or it dings on the switch.
- **Sound is synthesized, not a file** (WebAudio, two sine notes): no download,
  can't 404. It degrades to silence everywhere — no AudioContext, a blocked
  autoplay policy, or a throwing constructor must never surface an error.
- **Mount the watcher in the layout, not the sidebar.** The sidebar is
  `hidden md:flex`, so anything living inside it is dead weight on a phone
  browser.
