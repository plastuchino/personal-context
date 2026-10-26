# Spec Delta

## Purpose

Preserve personal source data and its history in a form that supports reliable filtering and citations back to exact evidence.

## ADDED Requirements

### Requirement: Stable canonical records
The system SHALL store canonical records in PostgreSQL with stable internal IDs and unique provider identities scoped to account and record kind. Original payloads and normalized text MUST be retained separately from derived interpretations.

#### Scenario: Same item received twice
- **WHEN** ingestion receives the same provider item again without changes
- **THEN** its canonical identity remains unchanged and no duplicate revision is created

### Requirement: Traceable revisions
Observed content changes SHALL create immutable revisions with capture timestamps. Chunks, embeddings, and classifications MUST identify the revision they describe.

#### Scenario: Source edits a message
- **WHEN** an edited message is ingested
- **THEN** a new revision becomes current while existing citations still identify the earlier revision

### Requirement: Provenance envelope
Every returned record or excerpt SHALL include its record ID, stable internal URI, applicable revision and chunk IDs, source timestamps, ingestion timestamp, and original source URL when available. Missing provider timestamps or links MUST be explicit null values.

#### Scenario: Provider has no permalink
- **WHEN** a result has no original provider URL
- **THEN** its stable internal URI and stored provenance still identify the exact record

### Requirement: Typed source details
The system SHALL preserve queryable participants, conversation membership, calendar timing, financial amounts and currencies, and available photo metadata. Exact financial values MUST NOT lose decimal precision, and calendar all-day dates MUST remain distinct from timestamped events.

#### Scenario: Exact financial lookup
- **WHEN** a transaction amount and currency are ingested
- **THEN** exact filtering uses the stored decimal value and currency without floating point rounding
