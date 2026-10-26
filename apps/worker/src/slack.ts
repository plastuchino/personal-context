import { loadConfig } from '@personal-context/config';
import { createPool } from '@personal-context/database';
import { credentialCipher } from '@personal-context/security';
import { socketController } from '../../../packages/connectors/src/slack-socket.js';
import { receiveSlackEvent } from '../../../packages/database/src/slack-events.js';
import { slackSocketStatus } from '../../../packages/database/src/slack-connection.js';

const pool = createPool(loadConfig());
const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
if (!key) { await pool.end(); throw new Error('CREDENTIAL_ENCRYPTION_KEY is required for Slack Socket Mode'); }
const cipher = credentialCipher(key);
const controllers = new Map<string, { stop: () => Promise<void> }>();
let stopped = false, refreshing = false;
// Each registered app has one socket transport, shared across its authorized installations.
const locks = await pool.connect();
async function refresh() {
 if (refreshing || stopped) return;
 refreshing = true;
 try {
  const installations = (await pool.query(`SELECT s.account_id,s.app_id,s.app_credential_ref,e.ciphertext FROM slack_connection_state s
   JOIN source_accounts a ON a.id=s.account_id JOIN encrypted_credentials e ON e.id=s.app_credential_ref
   WHERE a.status='active'`)).rows;
  const grouped = new Map<string, typeof installations>();
  for (const row of installations) grouped.set(row.app_id, [...(grouped.get(row.app_id) ?? []), row]);
  for (const [appId, rows] of grouped) {
   const identity = appId + ':' + rows.map(r => `${r.account_id}:${r.app_credential_ref}`).sort().join(',');
   if (controllers.has(identity)) continue;
   for (const [old, controller] of controllers) if (old.startsWith(appId + ':')) { await controller.stop(); controllers.delete(old); }
   const owned = (await locks.query('SELECT pg_try_advisory_lock(hashtext($1)) AS owned', ['slack-socket:' + appId])).rows[0].owned;
   if (!owned) continue;
   const ids = rows.map(r => r.account_id);
   try {
    const controller = socketController({ token: cipher.decrypt(rows[0].ciphertext),
     status: (status,code) => slackSocketStatus(pool,ids,status,code),
     receive: async envelope => {
      for (const account of ids) await receiveSlackEvent(pool,account,envelope.envelope_id,envelope.body);
      await envelope.ack();
     },
    });
    controllers.set(identity, { stop: async () => { await controller.stop(); await slackSocketStatus(pool,ids,'disconnected','worker_stopped'); await locks.query('SELECT pg_advisory_unlock(hashtext($1))',['slack-socket:'+appId]); } });
    await controller.start();
   } catch {
    await slackSocketStatus(pool,ids,'failed','socket_configuration_failed');
    await locks.query('SELECT pg_advisory_unlock(hashtext($1))',['slack-socket:'+appId]);
   }
  }
  for (const [identity,controller] of controllers) if (!grouped.has(identity.split(':')[0])) { await controller.stop(); controllers.delete(identity); }
 } finally { refreshing = false; }
}
const interval = setInterval(() => { void refresh().catch(() => console.error('Slack configuration refresh failed')); },15000);
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { void (async () => {
 stopped=true;clearInterval(interval);for (const controller of controllers.values()) await controller.stop();locks.release();await pool.end();
})().catch(() => { process.exitCode=1; }); });
try { await refresh(); } catch { console.error('Slack startup failed'); process.exitCode=1; clearInterval(interval); locks.release(); await pool.end(); }
