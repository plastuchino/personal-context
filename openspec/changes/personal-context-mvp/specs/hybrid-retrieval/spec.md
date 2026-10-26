# Spec Delta

## Purpose

Retrieve relevant personal context through complementary search methods while preserving precise filters and attributable excerpts.

## ADDED Requirements

### Requirement: Semantic and keyword retrieval
The system SHALL index normalized content for both semantic similarity and keyword search and provide combined ranking. Every supported record SHALL enter vector indexing; failures MUST remain visible and retryable instead of silently omitting records.

#### Scenario: Paraphrased query
- **WHEN** an agent searches for a concept expressed differently in stored content
- **THEN** semantic matching can return relevant content with per-excerpt provenance

#### Scenario: Embedding service outage
- **WHEN** embeddings cannot be generated
- **THEN** keyword and exact retrieval remain available and semantic coverage is reported as incomplete

### Requirement: Exact retrieval and filters
The system SHALL support direct record lookup and structured exact filters for source IDs, participants, dates, labels, task status, and supported source-specific values. Exact lookup MUST NOT depend on similarity thresholds.

#### Scenario: Exact amount filter
- **WHEN** a query specifies a transaction amount and currency
- **THEN** only authorized records matching those exact fields are eligible regardless of semantic similarity

### Requirement: Photo content indexing
Imported photos SHALL be indexed using available metadata, extracted visible text, and a generated visual description. Generated descriptions MUST be identified as model interpretations and retain model/version provenance separately from source metadata.

#### Scenario: Receipt photo
- **WHEN** a readable receipt is imported
- **THEN** extracted merchant text supports keyword search and a generated description supports semantic retrieval

### Requirement: Current and bounded results
Ordinary search SHALL return only current, non-deleted revisions with bounded result sizes and pagination. Results MUST report index freshness and source synchronization state. Model changes MUST NOT mix incompatible embeddings in one similarity index.

#### Scenario: Edited content awaiting indexing
- **WHEN** a source revision changes before its new embeddings are ready
- **THEN** old chunks are excluded from ordinary current search and incomplete semantic indexing is disclosed
