# Spec Delta

## Purpose

Give authenticated agents controlled access to attributable personal context without granting authority to change data or act for the owner.

## ADDED Requirements

### Requirement: Authenticated source-scoped access
Every MCP retrieval SHALL authenticate the client and enforce explicit source-account grants for search, records, citations, tasks, and freshness. Unauthorized resources MUST NOT be disclosed through content, counts, errors, or ranking metadata.

#### Scenario: Direct lookup bypass attempt
- **WHEN** a client requests a known record ID from an ungranted account
- **THEN** access is denied without disclosing that record's content or existence

#### Scenario: Revoked client
- **WHEN** a revoked credential calls an MCP tool
- **THEN** the call is rejected

### Requirement: Read-only MCP surface
MCP SHALL offer hybrid search, exact record/revision retrieval, blocking-task listing, and source freshness inspection. It MUST NOT offer record mutation, label mutation, task completion, synchronization controls, or provider-side actions in v1.

#### Scenario: Task completion requested
- **WHEN** an agent attempts to mark a task done
- **THEN** no supported MCP operation performs the action and persisted task state is unchanged

### Requirement: Attributable responses
Every content-bearing MCP result SHALL carry the provenance envelope defined by personal-data-storage, including task evidence excerpts. Internal citation URIs MUST be resolvable through authorized MCP retrieval without granting broader access.

#### Scenario: Task evidence retrieved
- **WHEN** a blocking task is returned
- **THEN** its evidence includes exact record references and timestamps rather than an uncited generated claim

### Requirement: Retrieval audit
The system SHALL audit client identity, tool, access decision, time, and returned record references without copying content or credentials into operational logs. Source content MUST be treated as data rather than trusted instructions.

#### Scenario: Embedded malicious instruction
- **WHEN** retrieved email text instructs the service to reveal another account
- **THEN** access grants remain enforced and the text is returned only as source content
