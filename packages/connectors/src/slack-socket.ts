import { SocketModeClient, LogLevel, type Logger } from '@slack/socket-mode';
import type { SlackEventBody } from '../../database/src/slack-events.js';

export interface SocketTransport {
 on(event: string, listener: (...args: any[]) => void): unknown;
 start(): Promise<unknown>;
 disconnect(): Promise<void>;
}
export interface SocketEnvelope { envelope_id: string; body: SlackEventBody; ack: () => Promise<void> }
export type SocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reauthorize' | 'failed';
export const silentSlackLogger: Logger = {
 debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {},
};
export function socketTransport(appToken: string): SocketTransport {
 return new SocketModeClient({ appToken, logger: silentSlackLogger, logLevel: LogLevel.ERROR,
  autoReconnectEnabled: false, clientOptions: { retryConfig: { retries: 0 }, timeout: 20000 } });
}
export function socketController(options: {
 token: string | null;
 receive: (envelope: SocketEnvelope) => Promise<void>;
 status: (state: SocketStatus, code: string | null) => Promise<void>;
 factory?: (token: string) => SocketTransport;
 retry?: (run: () => void, delay: number) => () => void;
}) {
 let client: SocketTransport | null = null;
 let stopped = false, attempts = 0, starting = false;
 let cancel: (() => void) | null = null;
 const pending = new Set<Promise<void>>();
 const track = (task: Promise<void>) => { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); };
 const retry = options.retry ?? ((run, delay) => { const timer = setTimeout(run, delay); return () => clearTimeout(timer); });
 const status = async (state: SocketStatus, code: string | null) => { await options.status(state, code); };
 const again = () => {
  if (stopped || cancel) return;
  if (++attempts > 12) { track(status('failed', 'reconnect_exhausted')); return; }
  cancel = retry(() => { cancel = null; track(connect()); }, Math.min(60000, 1000 * 2 ** (attempts - 1)));
 };
 const connect = async () => {
  if (stopped || starting) return;
  starting = true;
  try {
   if (!options.token) { await status('failed', 'missing_app_token'); return; }
   if (!client) {
    client = (options.factory ?? socketTransport)(options.token);
    client.on('connected', () => { attempts = 0; track(status('connected', null)); });
    client.on('disconnected', () => { if (!stopped) { track(status('disconnected', 'socket_disconnected')); again(); } });
    client.on('error', () => { if (!stopped) { track(status('disconnected', 'socket_error')); again(); } });
    client.on('slack_event', (envelope: SocketEnvelope) => {
     track((async () => {
      try {
       if(envelope.body?.type==='app_rate_limited'){await status('disconnected','event_rate_limited');await envelope.ack();}
       else await options.receive(envelope);
      }
      catch { await status('disconnected', 'event_persistence_failed'); }
     })());
    });
   }
   await status('connecting', null);
   await client.start();
  } catch (error) {
   const code = (error as {data?:{error?:string}})?.data?.error;
   if (['invalid_auth', 'token_revoked', 'not_authed', 'missing_scope'].includes(code ?? '')) {
    cancel?.(); cancel = null; await status('reauthorize', 'app_token_rejected');
   } else { await status('disconnected', 'socket_start_failed'); again(); }
  } finally { starting = false; }
 };
 return {
  start: connect,
  async flush() { while (pending.size) await Promise.all([...pending]); },
  async stop() { stopped = true; cancel?.(); cancel = null; await client?.disconnect(); while (pending.size) await Promise.all([...pending]); },
 };
}
