# Spec Delta

## Purpose

Let the owner connect data sources, import selected photos, and understand and recover pipeline failures through an operational dashboard.

## ADDED Requirements

### Requirement: Owner-only controls
Dashboard pages and operational API endpoints SHALL require owner authentication. The owner SHALL be able to manage source connections, explicit personal-conversation markings, and agent credentials with source grants. State-changing requests MUST reject unauthorized or forged requests.

#### Scenario: Agent credential used for dashboard action
- **WHEN** an MCP client credential attempts an operational retry
- **THEN** the dashboard API rejects it without scheduling work

### Requirement: Operational visibility
The dashboard SHALL display database size, source coverage and authorization state, scheduled and running jobs, last successful checks, provider freshness, record counts, classification/indexing backlog, unorganized counts, and detected errors. Operational logs MUST redact secrets and personal content.

#### Scenario: Pipeline partly failing
- **WHEN** ingestion succeeds but embedding fails
- **THEN** ingestion health and indexing failure are shown separately

### Requirement: Recoverable operations
The owner SHALL be able to retry failed jobs and reauthorize connections. Controls MUST respect stream locks and retry limits and distinguish provider limitations from service failures.

#### Scenario: Duplicate retry
- **WHEN** the owner retries a stream with an active job
- **THEN** no concurrent duplicate stream execution is created

### Requirement: Photo import interface
The dashboard SHALL initiate OAuth and Picker selection and display import progress and errors. It SHALL explain that Photos imports contain selected items rather than a continuously synchronized library.

#### Scenario: Photo import completes
- **WHEN** selected media has been ingested but analysis is pending
- **THEN** the dashboard distinguishes completed download from pending classification and indexing
