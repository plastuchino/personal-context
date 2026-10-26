# Capital One connection prerequisite

Task 4.7 requires a real production connection for the owner's Capital One account. Plaid is the initial candidate in the design; production eligibility, supported account types, and transaction-product access must be verified for the actual Item before accepting the financial connector. Sandbox fixtures are not live connectivity evidence.

The local feasibility command is `npm run bank:check`. It requires `PLAID_ENV=production`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, and an existing owner-authorized `PLAID_ACCESS_TOKEN` configured privately in `.env` or the process environment. Never paste those values into chat or commit them. Obtaining a new Item requires the owner's consent through the provider's Link flow; this probe does not implement that onboarding flow or accept bank passwords.

The probe reads Item/institution/account context and requests one transaction-sync result. It verifies the institution is Capital One and reports only account counts/types, transaction-access readiness, and available upstream freshness metadata. It does not log account IDs, balances, merchants, tokens, or provider error bodies. It does not request a paid transaction refresh, initiate payments, or modify the source account. Normal provider data-access billing remains governed by the configured account.

Missing configuration exits with code 2 before any provider request. Verification failure also exits 2 with a redacted reason. A production result establishes access and available freshness; it does not guarantee newly available bank data every fifteen minutes. The probe is separate from the still-pending financial ingestion adapter and does not persist financial records or advance task completion automatically.

## Current evidence

Plaid Sandbox credentials authenticated successfully. A simulated Capital One Item was created, encrypted locally, and ingested into a source explicitly marked `sandbox`: 14 synthetic account records and 16 transaction records in the configured history window. These counts describe the development smoke run, not the owner's real finances. Task 4.7 remains unchecked because no production connection has been verified.

References: [Items](https://plaid.com/docs/api/items/), [institutions](https://plaid.com/docs/api/institutions/), [transaction synchronization](https://plaid.com/docs/api/products/transactions/).

## Sandbox development

`npm run bank:sandbox` uses the private local Sandbox configuration and existing test access token to connect the simulated Item and ingest a due transaction batch. It refuses to run against Production. The source is labeled `sandbox` in both its display name and `provider_environment`; it receives no agent grant automatically. All credentials remain in ignored, owner-readable `.env` or encrypted credential storage. `npm run bank:check` retains its production-only acceptance requirement.

The adapter preserves monetary literals through lossless JSON parsing, exact PostgreSQL numeric fields, and original provider JSON. Positive amounts follow Plaid's outflow convention; negative amounts represent inflows/refunds. Date-only transaction dates remain dates, with source instants null when unavailable. Pending-to-posted links tombstone the superseded pending record to avoid double counting, including delayed replays. Removed transactions become tombstones; updates create revisions.

A complete transaction-sync pagination batch is fetched before advancing the durable cursor. Mutation-during-pagination errors discard the partial batch and restart from the original stable cursor. `NOT_READY` is retryable and does not count as successful coverage. Provider freshness is stored separately from successful check time; no paid refresh is requested.
