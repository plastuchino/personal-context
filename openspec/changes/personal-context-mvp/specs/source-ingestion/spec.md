# Spec Delta

## Purpose

Keep authorized personal sources synchronized with observable progress and recoverable failures, including explicit photo imports.

## ADDED Requirements

### Requirement: Authorized source coverage
The system SHALL support Gmail messages, accessible Slack messages and threads, Google Calendar events, Capital One transactions and account context, and selected Google Photos media. It MUST expose access limitations and expired authorization without fabricating coverage.

#### Scenario: Financial connection unavailable
- **WHEN** the configured financial provider cannot access the owner's Capital One account
- **THEN** the connection is reported as unavailable and the source is not reported as synchronized

#### Scenario: Restricted Slack access
- **WHEN** a conversation is inaccessible to the authorized token
- **THEN** the system reports the coverage limitation without attempting to bypass access controls

### Requirement: Fifteen minute incremental checks
The system SHALL schedule enabled non-Photos streams every 15 minutes and persist independent progress. It SHALL distinguish check time, successful ingestion time, and provider data freshness.

#### Scenario: No new bank data
- **WHEN** a scheduled financial check succeeds but the upstream data has not advanced
- **THEN** the check succeeds without claiming that bank data became current at check time

### Requirement: Durable recovery
Synchronization SHALL be idempotent, preserve committed records on failure, retry transient failures with bounded backoff, honor rate limits, and prevent concurrent ownership of a stream. Checkpoints MUST advance only after their corresponding data is durable.

#### Scenario: Worker crashes before checkpoint
- **WHEN** a worker restarts after storing a page but before checkpointing
- **THEN** replaying the page produces no duplicate records and synchronization can resume

#### Scenario: Expired cursor
- **WHEN** a provider rejects a stored cursor
- **THEN** the system records the reset and performs a controlled resynchronization

### Requirement: Selected Google Photos import
The dashboard SHALL offer Google OAuth and a Google Photos Picker session. Only explicitly selected media SHALL be imported. Photos MUST NOT be represented as an automatically synchronized whole library.

#### Scenario: Selection completes
- **WHEN** the owner completes a Picker session
- **THEN** the selected media and available metadata enter the durable ingestion and indexing pipeline

#### Scenario: Selection expires
- **WHEN** a session or download authorization expires before import completes
- **THEN** the import exposes a recoverable error and requests a new selection when required

### Requirement: Source changes and initial coverage
Connectors SHALL process available edits and deletions, support a configured initial history range, and expose completed coverage. Records outside known coverage MUST NOT be implied to have been ingested.

#### Scenario: Source deletion observed
- **WHEN** the provider reports a previously ingested item deleted
- **THEN** that item is tombstoned and excluded from ordinary retrieval

### Requirement: Slack event synchronization
The system SHALL receive authorized Slack message, reply, edit, and deletion events through Socket Mode while retaining 15-minute reconciliation. Events MUST be mapped to the authorized installation and source account; event access MUST NOT expand the owner's configured source coverage.

#### Scenario: Older message edited
- **WHEN** Slack delivers an edit for an ingested message older than the recent polling cursor
- **THEN** the system creates a new source revision and queues derived-data refresh without waiting for the message to reappear in recent history

#### Scenario: Message deleted
- **WHEN** an authorized deletion event identifies an ingested Slack message
- **THEN** that record is tombstoned and excluded from ordinary retrieval

#### Scenario: Unauthorized installation event
- **WHEN** an event cannot be mapped to an authorized source installation
- **THEN** it is not ingested into another source account and its content is not exposed in operational logs

### Requirement: Durable and ordered Slack event processing
Accepted Slack events SHALL be durable before transport acknowledgment and processed idempotently. Duplicate or out-of-order deliveries and concurrent reconciliation MUST NOT duplicate revisions, regress current content, or resurrect a message deleted by newer evidence.

#### Scenario: Receipt acknowledged before worker crash
- **WHEN** a worker restarts after durable event receipt but before processing completes
- **THEN** the event remains available for processing without depending on Slack redelivery

#### Scenario: Duplicate delivery
- **WHEN** Slack redelivers an event already stored for the same account
- **THEN** it is acknowledged without duplicating its record revisions or downstream work

#### Scenario: Late stale history page
- **WHEN** an older history result arrives after a newer deletion event
- **THEN** the deleted message remains excluded from ordinary retrieval

#### Scenario: Event persistence unavailable
- **WHEN** an accepted event cannot be durably stored
- **THEN** the service does not acknowledge it as successfully received

### Requirement: Slack connection recovery and coverage
The system SHALL reconnect interrupted Slack event connections and report event receipt, processing, reconciliation, and coverage gaps separately. Scheduled reconciliation SHALL recover available missed changes and revisit tracked threads. Reconnection alone MUST NOT imply complete coverage or recovery of unavailable history.

#### Scenario: Connection interrupted
- **WHEN** event delivery disconnects
- **THEN** the source reports a delivery gap, attempts reconnection, and retains scheduled reconciliation

#### Scenario: Missed reply in an older thread
- **WHEN** an accessible tracked thread whose parent predates the recent cursor receives a reply during an outage
- **THEN** reconciliation revisits that thread and imports the reply

#### Scenario: Retention prevents recovery
- **WHEN** provider retention or lost access prevents verifying an outage range
- **THEN** the range remains explicitly incomplete and missing history is not treated as proof of deletion
