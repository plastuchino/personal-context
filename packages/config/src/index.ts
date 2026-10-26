export interface ModelConfig {
  adapter?: 'gateway' | 'ollama';
  timeoutMs?:number;
  endpoint: string;
  model: string;
  version: string;
  apiKey: string | undefined;
}
export interface Config {
  databaseUrl: string;
  apiHost: string;
  apiPort: number;
  maxMediaBytes: number;
  backfillDays: number;
  calendarFutureDays: number;
  embedding: (ModelConfig & { dimensions: number }) | null;
  classifier: ModelConfig | null;
  vision: ModelConfig | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  let database: URL;
  try { database = new URL(raw); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || database.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host and database');
  }
  const port = env.API_PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('API_PORT must be between 1 and 65535');
  const apiHost = env.API_HOST ?? '127.0.0.1';
  if (!apiHost.trim()) throw new Error('API_HOST must not be empty');
  const integer = (key: string, fallback: number, max: number): number => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
    return Number(value);
  };
  const model = (prefix: string): ModelConfig | null => {
    const keys = [`${prefix}_ENDPOINT`, `${prefix}_MODEL`, `${prefix}_VERSION`, `${prefix}_API_KEY`, `${prefix}_ADAPTER`, `${prefix}_TIMEOUT_MS`];
    if (keys.every((key) => env[key] === undefined)) return null;
    if (keys.slice(0, 3).some((key) => !env[key]?.trim())) throw new Error(`${prefix} requires endpoint, model, and version`);
    let endpoint: URL;
    try { endpoint = new URL(env[keys[0]]!); } catch { throw new Error(`${prefix}_ENDPOINT must be an HTTP URL`); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error(`${prefix}_ENDPOINT must be an HTTP URL without embedded credentials`);
    if (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error(`${prefix}_ENDPOINT requires HTTPS for remote services`);
    const adapter=env[`${prefix}_ADAPTER`]??'gateway';
    if(!['gateway','ollama'].includes(adapter))throw new Error(`${prefix}_ADAPTER must be gateway or ollama`);
    if(adapter==='ollama'&&(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/'||endpoint.search||endpoint.hash))throw new Error(`${prefix}_ENDPOINT must be a loopback Ollama origin`);
    if(adapter==='ollama'&&!/^sha256:[a-f0-9]{64}$/.test(env[keys[2]]!))throw new Error(`${prefix}_VERSION must pin the Ollama model digest`);
    return { timeoutMs:integer(`${prefix}_TIMEOUT_MS`,prefix==='VISION'?180000:60000,600000), adapter:adapter as 'gateway'|'ollama', endpoint: endpoint.toString(), model: env[keys[1]]!, version: env[keys[2]]!, apiKey: env[keys[3]] };
  };
  const embedding = model('EMBEDDING');
  if (!embedding && env.EMBEDDING_DIMENSIONS !== undefined) throw new Error('EMBEDDING_DIMENSIONS requires embedding model configuration');
  if (embedding && !env.EMBEDDING_DIMENSIONS) throw new Error('EMBEDDING_DIMENSIONS is required for the pinned model');
  return {
    databaseUrl: raw, apiHost, apiPort: Number(port),
    maxMediaBytes: integer('MAX_MEDIA_BYTES', 20971520, 1073741824),
    backfillDays: integer('BACKFILL_DAYS', 30, 36500),
    calendarFutureDays: integer('CALENDAR_FUTURE_DAYS', 90, 36500),
    embedding: embedding ? { ...embedding, dimensions: integer('EMBEDDING_DIMENSIONS', 1, 2000) } : null,
    classifier: model('CLASSIFIER'), vision: model('VISION'),
  };
}
