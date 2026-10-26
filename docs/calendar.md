# Calendar connector

The Calendar connection uses `calendar.readonly` through the owner OAuth flow. `calendarListPage` discovers accessible calendars with pagination; each calendar gets an independent stream and cursor when the scheduler is wired. Removed access is a connection/coverage error, not proof that its events were deleted.

`calendarPage` synchronizes event definitions and recurrence exceptions with a per-calendar sync token, then refreshes a bounded expanded-instance window. Defaults are the previous 30 days and next 90 days. A cycle freezes its window bounds across pagination; the next cycle advances them with the current date. This captures unchanged recurring instances entering the future window without trying to expand an unlimited series.

The delta phase uses `singleEvents=false`, preserving masters, recurrence rules, and overrides. Initial delta requests have configured time bounds. Incremental requests carry the prior sync token without incompatible time filters, and keep that token stable through all pages until the final replacement token arrives. The window phase uses `singleEvents=true` and explicit bounds without a sync token. It preserves provider instance IDs, parent-series IDs, and original start values. Identical definition/window records deduplicate through canonical ingestion.

All-day events keep date-only start and exclusive end boundaries; no midnight timestamp is fabricated. Timed events use explicit offsets or provider timezones and are normalized to UTC while preserving timezone/source fields. Invalid or missing timing fails visibly. Canceled events can lack timing fields and are ingested as tombstones. Canceling a series also tombstones its stored instances; immutable revisions remain for citations.

An expired sync token returns an explicit reset and restarts controlled synchronization without deleting stored data based on an incomplete response. Reset gaps remain visible because a later bounded snapshot cannot establish every unavailable historical change. Coverage describes the successfully fetched window, not the entire calendar history. Token and bounded-window checkpoints use the durable ingestion transaction; full scheduled orchestration is tracked in task 4.9.

References: [incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), [event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents).
