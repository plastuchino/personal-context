ALTER TABLE source_accounts ADD COLUMN provider_environment text NOT NULL DEFAULT 'production' CHECK(provider_environment IN ('sandbox','production'));
ALTER TABLE financial_transaction_details ADD COLUMN posted_date date;
CREATE INDEX transaction_posted_date ON financial_transaction_details(posted_date);
