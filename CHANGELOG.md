# Changelog

## 0.1.1

- Packaging: `npm pack` tarball, portable zip, MIT LICENSE, `engines.dsh`.
- Workspace entries created during a borrow are now removed by id, against a
  baseline captured while armed; the machine owner's entries stay.
- Audit and wipe got time budgets (2.5 s / 5 s) so a large store reports
  partial sizes instead of hanging.
- 7 tests cover ownership: sessions, anonymous files by creation time,
  credential refs, workspaces, the full-wipe escape hatch, and the refs parser.

## 0.1.0

- Borrowed-device mode: auto-arm on an unknown machine, persistent bar above
  the composer, ownership-aware audit, cleanup of your own traces only.
- Key-shred feature removed: the runtime resolves the ambient credential layer
  from an immutable launch snapshot, so a runtime `process.env` write is never
  seen (`/borrowed selftest` proves it).
