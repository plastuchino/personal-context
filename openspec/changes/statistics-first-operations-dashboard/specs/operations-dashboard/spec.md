# Spec Delta

## Purpose

Help the owner understand aggregate data and pipeline health, then inspect bounded operational history through dedicated dashboard screens.

## ADDED Requirements

### Requirement: Statistics-first navigation
The authenticated dashboard SHALL open on an Overview with aggregate statistics and health summaries. Persistent navigation SHALL expose Sources, Job History, Failures, Photo Imports, and Settings as separate screens. Overview SHALL NOT render operational history tables or raw ingested content. Navigation SHALL support direct links and browser Back/Forward.

#### Scenario: Owner opens the dashboard
- **WHEN** the owner opens the dashboard without a screen selected
- **THEN** Overview displays and history is accessible through sidebar navigation without appearing on the front page

#### Scenario: Narrow display
- **WHEN** the owner uses a narrow viewport
- **THEN** navigation remains accessible through a collapsible menu and the selected screen remains usable

### Requirement: Full-dataset aggregate statistics
Overview SHALL show human-readable total database and media sizes, active record count, counts and shares by source, classification counts, and stage-specific queued, running, and failed work. Statistics SHALL cover all applicable data independently of history pages and filters. Database size SHALL be identified as physical storage rather than source payload size.

#### Scenario: History spans multiple pages
- **WHEN** more than 50 jobs exist and the owner views a filtered history page
- **THEN** Overview totals still represent the full applicable dataset

#### Scenario: No records exist
- **WHEN** no active records exist
- **THEN** record totals and source shares display zero without invalid percentages

### Requirement: Classification statistics preserve meaning
Overview SHALL count personal, background, blocking, update, and unorganized labels on active records only when classifications match the current revision and context version. It SHALL display pending or stale records separately and explain that labels overlap. Zero-count categories SHALL remain visible.

#### Scenario: Overlapping labels and stale results
- **WHEN** a current record has personal and blocking labels and another record has only stale classification
- **THEN** the first contributes to both label counts and the second contributes to pending or stale rather than current label counts

### Requirement: Source freshness summaries
Overview SHALL show each connected source's authorization state, elapsed time since last poll attempt and successful poll, provider watermark, and coverage health. Missing observations SHALL be explicit. Stream failures SHALL remain distinguishable from successful streams; Slack delivery health SHALL remain distinct from polling. Photos SHALL be identified as manual imports.

#### Scenario: Recent attempt fails
- **WHEN** a source poll fails after an earlier success
- **THEN** the recent attempt and older successful poll are shown separately with the failure state

#### Scenario: Source uses manual import
- **WHEN** the source is Google Photos
- **THEN** the summary identifies manual imports and does not imply a scheduled poll is overdue

### Requirement: Bounded operational history
Job History, Failures, and Photo Imports SHALL fetch and render at most 50 entries per page using server-side pagination. Each SHALL offer Previous/Next controls with unavailable directions disabled, newest-first deterministic ordering, and source, status, and date filters. Page changes SHALL replace entries. Invalid pagination and filter inputs SHALL be rejected.

#### Scenario: Fifty-one matching entries
- **WHEN** 51 matching entries exist
- **THEN** page one shows 50 entries and Next shows the remaining entry without accumulating the first page

#### Scenario: Equal timestamps and new arrivals
- **WHEN** entries share timestamps and newer entries arrive during browsing
- **THEN** pagination retains deterministic ordering and does not duplicate or skip existing entries because of those arrivals

#### Scenario: Filter changes
- **WHEN** the owner changes a history filter
- **THEN** pagination resets to the first matching page and an empty result displays an explicit empty state

### Requirement: Operational browsing continuity
Refreshing SHALL preserve the selected screen, filters, and history position. Older history pages SHALL NOT be automatically replaced by newly arriving entries. Failed job retries and Photos selection/progress controls SHALL remain available on their relevant screens, with existing authentication, CSRF protection, redaction, and retry restrictions preserved.

#### Scenario: Owner reads older failures
- **WHEN** background refresh occurs while the owner reads an older failure page
- **THEN** the visible page and filters remain in place and the owner can explicitly return to newest entries

#### Scenario: Unauthorized history request
- **WHEN** an unauthenticated caller or agent credential requests an operational history endpoint
- **THEN** access is denied and no operational entries are returned
