import { DateTime } from 'luxon';
import type { SourceRecord } from '../../database/src/records.js';
import { ProviderError, type ProviderGet } from './http.js';

interface CalendarTime { date?: string; dateTime?: string; timeZone?: string }
export interface CalendarEvent {
 id: string; summary?: string; description?: string; location?: string; htmlLink?: string;
 created?: string; updated?: string; status?: string; start?: CalendarTime; end?: CalendarTime;
 recurringEventId?: string; originalStartTime?: CalendarTime; recurrence?: string[];
 organizer?: {email?:string;displayName?:string;self?:boolean};
 attendees?: {email?:string;displayName?:string;self?:boolean}[];
 [key:string]:unknown;
}
function instant(value: CalendarTime): string {
 if (!value.dateTime || (!/(Z|[+-]\d\d:\d\d)$/.test(value.dateTime) && !value.timeZone)) throw new Error('Calendar instant requires an offset or timezone');
 const date = DateTime.fromISO(value.dateTime, {zone:value.timeZone??'UTC',setZone:true});
 if(!date.isValid)throw new Error('Invalid calendar instant');
 return date.toUTC().toISO()!;
}
function dateOnly(value:string):string {
 if(!/^\d{4}-\d\d-\d\d$/.test(value)||!DateTime.fromISO(value,{zone:'UTC'}).isValid)throw new Error('Invalid calendar date');
 return value;
}
export function calendarRecord(accountId:string,calendarId:string,event:CalendarEvent):SourceRecord {
 const source:SourceRecord={accountId,externalId:`${calendarId}:${event.id}`,kind:'calendar-event',title:event.summary??'',
  bodyText:[event.summary,event.description,event.location,JSON.stringify({start:event.start??null,end:event.end??null,recurrence:event.recurrence??null})].filter(Boolean).join('\n'),
  rawPayload:event,sourceUrl:event.htmlLink??null,sourceCreatedAt:event.created??null,sourceUpdatedAt:event.updated??null,deleted:event.status==='cancelled'};
 if(source.deleted)return source;
 if(!event.start||!event.end)throw new Error('Calendar event lacks timing');
 const allDay=!!event.start.date;
 source.calendar={allDay,startDate:allDay?dateOnly(event.start.date!):null,endDate:allDay?dateOnly(event.end.date??''):null,
  startsAt:allDay?null:instant(event.start),endsAt:allDay?null:instant(event.end),timezone:event.start.timeZone??event.end.timeZone??null,
  recurrenceId:event.recurringEventId?`${calendarId}:${event.recurringEventId}`:null,
  originalStart:event.originalStartTime?.dateTime??event.originalStartTime?.date??null,
  recurrenceRules:event.recurrence??[],status:event.status??'confirmed'};
 source.participants=[...(event.organizer?.email?[{...event.organizer,role:'organizer'}]:[]),...(event.attendees??[]).filter(a=>a.email).map(a=>({...a,role:'attendee'}))].map(a=>({externalId:a.email!.toLowerCase(),email:a.email,displayName:a.displayName,isSelf:!!a.self,role:a.role}));
 return source;
}
export interface CalendarCursor {
 phase:'delta'|'window'; syncToken?:string; pageToken?:string; windowStart:string;windowEnd:string;
 cycleComplete?:boolean; resetGap?:boolean;
}
export async function calendarListPage(get:ProviderGet,pageToken?:string):Promise<{calendars:any[];nextPageToken:string|null}> {
 const data=await get('/users/me/calendarList',{maxResults:'100',pageToken,showDeleted:'true'});
 return {calendars:data.items??[],nextPageToken:data.nextPageToken??null};
}
export async function calendarPage(get:ProviderGet,accountId:string,calendarId:string,cursor:CalendarCursor|null,backfillDays:number,futureDays:number,now=new Date()):Promise<{records:SourceRecord[];cursor:CalendarCursor|null;complete:boolean;reset?:boolean;coverageStart?:string;coverageEnd?:string;coverageComplete?:boolean;watermark?:string}> {
 const bounds={windowStart:new Date(now.getTime()-backfillDays*86400000).toISOString(),windowEnd:new Date(now.getTime()+futureDays*86400000).toISOString()};
 const state:CalendarCursor=cursor&&!cursor.cycleComplete?cursor:{...cursor,...bounds,phase:'delta',cycleComplete:false};
 const params:Record<string,string|undefined>={maxResults:'100',showDeleted:'true',singleEvents:state.phase==='window'?'true':'false',pageToken:state.pageToken};
 if(state.phase==='delta'&&state.syncToken)params.syncToken=state.syncToken;
 else {params.timeMin=state.windowStart;params.timeMax=state.windowEnd;}
 let data:any;
 try{data=await get(`/calendars/${encodeURIComponent(calendarId)}/events`,params);}
 catch(error){if(error instanceof ProviderError&&error.status===410&&state.phase==='delta'&&state.syncToken)return {records:[],cursor:{phase:'delta',...bounds,resetGap:true},complete:false,reset:true,coverageComplete:false};throw error;}
 const records=(data.items??[]).map((event:CalendarEvent)=>calendarRecord(accountId,calendarId,event));
 let next:CalendarCursor,complete=false;
 if(data.nextPageToken)next={...state,pageToken:data.nextPageToken};
 else if(state.phase==='delta'){
  if(!data.nextSyncToken)throw new Error('Calendar synchronization token missing');
  next={...state,phase:'window',syncToken:data.nextSyncToken,pageToken:undefined};
 }else{complete=true;next={...state,phase:'delta',pageToken:undefined,cycleComplete:true};}
 return {records,cursor:next,complete,coverageStart:state.windowStart,coverageEnd:state.windowEnd,coverageComplete:complete&&!state.resetGap,
  watermark:typeof data.updated==='string'?data.updated:undefined};
}
