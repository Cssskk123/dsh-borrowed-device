# Changelog

## 0.1.3

- The packaged README no longer pins a release URL. The agent-install prompt now
  resolves the current zip from the releases API, so it keeps working after the
  next version instead of 404-ing.

## 0.1.2

- The composer bar now uses the host's own width variables
  (`--dsh-composer-card-max-width` plus the side clearance), so it lines up
  with the composer on wide, medium and narrow layouts instead of a fixed
  820px.
- Status polling dropped from 8 s to 20 s; the bar also refreshes on window
  focus and on becoming visible, and disposes both listeners on unmount.
- README trimmed to install and usage. Ownership rules, the cleanup inventory,
  the API-key story and known limits moved to `docs/internals.md`.
- README documents an agent-install prompt and the stable
  `releases/latest/download/...` URL.

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
