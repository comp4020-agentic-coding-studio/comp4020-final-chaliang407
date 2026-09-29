# ANU Room Booking (student demo)

A small, self-contained slice of an ANU room-booking system: browse a short
list of study/meeting rooms and book one for a time slot, with the booking
actually persisting.

## The problem this responds to

Booking a small study or meeting room at ANU — for a group project, a
tutoring session, a club meeting — usually means going through a heavier
system built around lecture theatres and timetabling, or falling back to an
email or spreadsheet process for the smaller, informal spaces that don't fit
that system well. This project is the small piece of that a student would
actually want: pick a room, see what's free, book it, and have the booking
still be there when you come back.

It does not attempt to be a full room-booking or timetabling system, and it
isn't connected to any real ANU system or data. The rooms shown are fictional
demo data seeded for this project.

## Deliberately small scope

What exists:

- a fixed, seeded list of demo rooms (name, location, capacity)
- creating a booking for a room and time, with server-side validation
- rejecting a booking that overlaps an existing one for the same room
- cancelling a booking
- all of the above stored in SQLite, surviving a reload or a server restart

What's intentionally left out: accounts or login, editing an existing
booking, a calendar or day/week view, filtering or searching rooms, recurring
bookings, and anything resembling an admin panel. Any of that would turn this
into a different, larger system rather than a well-finished slice of one.

## Core flow and persistence

1. `/` lists the available demo rooms as cards showing name, location, and
   capacity.
2. Each room card opens directly into a booking form for that room, so there's
   no separate room selector to keep in sync with the list above it.
3. Submitting a valid, non-overlapping booking is validated and stored on the
   server, then shown under "My bookings" with a human-readable date/time.
4. Reloading the page re-reads the same data from SQLite, so the booking is
   still there.
5. Cancelling a booking deletes it, and that removal persists the same way.

In production the SQLite database lives under `/data`, the one path that
survives a redeploy on this app's Fly.io setup.

## Local development

```sh
pnpm install
pnpm dev          # http://localhost:4321, dev database under .data/
pnpm typecheck
pnpm build
pnpm start        # runs the built server, e.g. for pnpm check below
pnpm check        # typecheck + spec/*.test.ts against a running instance
```

`pnpm check` expects the app to already be answering at `APP_URL`
(`http://localhost:8080` by default) — start it with `pnpm dev` or `pnpm
start` first.

## Status

Student project for COMP4020 (Agentic Coding Studio). Not an official ANU
service; the rooms and bookings shown are fictional.
