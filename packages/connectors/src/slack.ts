import type { SourceRecord } from '../../database/src/records.js';
import { ProviderError, type ProviderGet } from './http.js';

export interface SlackConversation {
 id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean;
 is_member?: boolean; is_archived?: boolean;
}
export interface SlackMessage {
 ts: string; text?: string; user?: string; bot_id?: string; thread_ts?: string;
 reply_count?: number; edited?: { ts: string }; permalink?: string;
 [key: string]: unknown;
}
export interface SlackPage {
 records: SourceRecord[]; nextCursor: string | null; threadIds: string[];
 coverage: { start: string; end: string; complete: boolean; limited: boolean };
}
export function slackTimestamp(ts: string): string {
 if (!/^\d+\.\d{1,6}$/.test(ts)) throw new Error('Invalid Slack timestamp');
 const [seconds, fraction] = ts.split('.');
 return new Date(Number(seconds) * 1000 + Number(fraction.padEnd(6, '0').slice(0, 3))).toISOString();
}
export async function slackCall(get: ProviderGet, method: string, params: Record<string, string | undefined> = {}): Promise<any> {
 const data = await get('/' + method, params);
 if (!data.ok) {
  const code = String(data.error ?? 'unknown');
  const access = ['channel_not_found', 'not_in_channel', 'missing_scope', 'no_permission'];
  throw new ProviderError(access.includes(code) ? 'source_inaccessible' : ['invalid_auth', 'token_revoked', 'token_expired'].includes(code) ? 'reauthorize' : code === 'ratelimited' ? 'rate_limited' : 'provider_error', access.includes(code) ? 403 : 400);
 }
 return data;
}
export async function slackConversations(get: ProviderGet, cursor?: string): Promise<{ conversations: SlackConversation[]; nextCursor: string | null }> {
 const data = await slackCall(get, 'conversations.list', { types: 'public_channel,private_channel,im,mpim', exclude_archived: 'false', limit: '100', cursor });
 return { conversations: data.channels ?? [], nextCursor: data.response_metadata?.next_cursor || null };
}
export function slackRecord(accountId: string, channel: SlackConversation, message: SlackMessage, selfId: string): SourceRecord {
 const author = message.user ?? message.bot_id;
 return {
  accountId, externalId: `${channel.id}:${message.ts}`, kind: 'slack-message',
  sourceCreatedAt: slackTimestamp(message.ts), sourceUpdatedAt: message.edited ? slackTimestamp(message.edited.ts) : null,
  sourceUrl: message.permalink ?? null, title: channel.name ?? channel.id,
  bodyText: message.text ?? '', rawPayload: message,
  conversation: { externalId: channel.id, kind: channel.is_im ? 'direct' : channel.is_mpim ? 'group' : 'channel', title: channel.name ?? channel.id },
  participants: author ? [{ externalId: author, role: 'author', isSelf: author === selfId }] : [],
  slack: { channelId: channel.id, messageTs: message.ts, threadTs: message.thread_ts ?? ((message.reply_count ?? 0)>0 ? message.ts : null), version: message.edited?.ts ?? message.ts },
 };
}
export async function slackMessages(get: ProviderGet, accountId: string, channel: SlackConversation, selfId: string, range: { oldest: string; latest: string }, cursor?: string, threadTs?: string): Promise<SlackPage> {
 const data = await slackCall(get, threadTs ? 'conversations.replies' : 'conversations.history', {
  channel: channel.id, oldest: range.oldest, latest: range.latest, inclusive: 'true', limit: '100', cursor, ts: threadTs,
 });
 const nextCursor = data.response_metadata?.next_cursor || null;
 if (data.has_more && !nextCursor) throw new ProviderError('pagination_incomplete', 502);
 const messages = (data.messages ?? []) as SlackMessage[];
 return {
  records: messages.map(message => slackRecord(accountId, channel, message, selfId)),
  nextCursor, threadIds: [...new Set(messages.filter(m => (m.reply_count ?? 0) > 0).map(m => m.thread_ts ?? m.ts))],
  coverage: { start: slackTimestamp(range.oldest), end: slackTimestamp(range.latest), complete: !nextCursor && !data.is_limited, limited: !!data.is_limited },
 };
}

export interface SlackReconcileCursor {
 phase: 'history'|'threads'; oldest:string; latest:string; page?:string; threads:string[]; threadIndex:number; limited:boolean;
}
export async function slackReconciliationPage(get:ProviderGet,accountId:string,channel:SlackConversation,selfId:string,backfillDays:number,trackedThreads:string[],cursor:SlackReconcileCursor|null,now=new Date()):Promise<{records:SourceRecord[];cursor:SlackReconcileCursor|null;complete:boolean;coverageStart:string;coverageEnd:string;coverageComplete:boolean}> {
 const latest=(Math.floor(now.getTime()/1000))+'.000000';
 const state:SlackReconcileCursor=cursor??{phase:'history',oldest:(Math.floor(now.getTime()/1000)-backfillDays*86400)+'.000000',latest,threads:[...new Set(trackedThreads)],threadIndex:0,limited:false};
 const thread=state.phase==='threads'?state.threads[state.threadIndex]:undefined;
 const page=await slackMessages(get,accountId,channel,selfId,{oldest:state.oldest,latest:state.latest},state.page,thread);
 const next={...state,limited:state.limited||page.coverage.limited,threads:[...new Set([...state.threads,...page.threadIds])]};
 let complete=false;
 if(page.nextCursor)next.page=page.nextCursor;
 else{
  next.page=undefined;
  if(state.phase==='history')next.phase='threads';else next.threadIndex++;
  complete=next.threadIndex>=next.threads.length;
 }
 return {records:page.records,cursor:complete?null:next,complete,coverageStart:slackTimestamp(state.oldest),coverageEnd:slackTimestamp(state.latest),coverageComplete:complete&&!next.limited&&Number(state.latest)-Number(state.oldest)>=7*86400};
}
