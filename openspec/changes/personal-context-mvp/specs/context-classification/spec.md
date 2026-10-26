# Spec Delta

## Purpose

Identify personal relevance and attention needs while keeping classification evidence, failures, and outstanding requests observable.

## ADDED Requirements

### Requirement: Overlapping contextual labels
Each successfully classified revision SHALL receive one or more of personal, background, blocking, and update. Personal indicates information received through the owner's action or in response to it; background indicates routine context; blocking indicates another party requires owner action; update indicates a notification or upcoming obligation.

#### Scenario: Personal request for a decision
- **WHEN** a reply to the owner's email asks them to choose a refund option
- **THEN** it receives both personal and blocking labels

#### Scenario: Routine newsletter
- **WHEN** a newsletter contains routine information without an individual request
- **THEN** it receives background and is not marked blocking solely because it contains promotional calls to action

#### Scenario: Upcoming payment
- **WHEN** a notification announces an upcoming payment
- **THEN** it receives update and any additional independently supported labels

### Requirement: Group participation relevance
A group conversation SHALL qualify as personal when explicitly marked personal, when the owner sent at least five messages in the preceding seven days, or when the owner's messages constitute at least 10 percent of messages in that window. Empty windows MUST NOT qualify by ratio. Coverage limitations MUST be exposed.

#### Scenario: Participation ratio qualifies
- **WHEN** the owner sent two of twenty observed messages in a complete seven-day window
- **THEN** the conversation qualifies as personal

#### Scenario: Activity ages out
- **WHEN** a rolling window no longer meets either activity threshold and no explicit personal marking exists
- **THEN** the activity-based qualification is recomputed and no longer applies

### Requirement: Classification accountability and recovery
Classification SHALL record revision, rule/model version, evidence, confidence where available, and processing state. Unorganized SHALL be used only when classification cannot complete, with an actionable error. Pending or stale classification MUST be distinguishable from completed classification.

#### Scenario: Classifier unavailable
- **WHEN** classification fails after bounded retries
- **THEN** the record remains retrievable with unorganized and an observable failure

#### Scenario: Recovery succeeds
- **WHEN** retry successfully classifies the failed revision
- **THEN** unorganized is replaced with supported labels and prior failure history is retained

### Requirement: Outstanding requests
The system SHALL associate blocking content with evidence-backed tasks and expose open, done, or uncertain status. Resolution MUST require source evidence; passage of a deadline alone MUST NOT imply completion. A task can reference multiple records and a record can support multiple tasks.

#### Scenario: Resolution observed
- **WHEN** a later source message explicitly establishes a request was fulfilled
- **THEN** the task can be marked done with a reference to that evidence while the original blocking label remains historical context
