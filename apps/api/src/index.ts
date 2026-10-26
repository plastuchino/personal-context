import {createModelAdapters} from '@personal-context/models';
import { serve } from '@hono/node-server';
import { loadConfig } from '@personal-context/config';
import { createPool } from '@personal-context/database';
import { createApp } from './app.js';

const config = loadConfig();
const pool = createPool(config);
const app = createApp(pool, process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173', {googleClientId:process.env.GOOGLE_CLIENT_ID,googleClientSecret:process.env.GOOGLE_CLIENT_SECRET,slackClientId:process.env.SLACK_CLIENT_ID,slackClientSecret:process.env.SLACK_CLIENT_SECRET,slackAppId:process.env.SLACK_APP_ID,slackRedirectUri:process.env.SLACK_REDIRECT_URI,encryptionKey:process.env.CREDENTIAL_ENCRYPTION_KEY},fetch,{models:createModelAdapters(config),embedding:config.embedding});
const server = serve({ fetch: app.fetch, hostname: config.apiHost, port: config.apiPort });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { void pool.end(); }));
}
