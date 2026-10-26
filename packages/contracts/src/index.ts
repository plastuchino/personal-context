export const providers = ['gmail', 'slack', 'calendar', 'capital-one', 'google-photos'] as const;
export type Provider = typeof providers[number];
export const labels = ['personal', 'background', 'blocking', 'update', 'unorganized'] as const;
export type Label = typeof labels[number];
export type TaskStatus = 'open' | 'done' | 'uncertain';
export interface Provenance {
  record_id: string;
  record_uri: string;
  revision_id: string | null;
  chunk_id: string | null;
  source_url: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  ingested_at: string;
}
export interface HealthResponse {
  service: 'personal-context-api';
  status: 'ok';
}
