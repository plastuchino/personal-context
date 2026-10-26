import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarRecord,calendarPage} from '../packages/connectors/src/calendar.js';
import {ProviderError} from '../packages/connectors/src/http.js';
test('calendar preserves all-day exclusive dates and recurrence exception identity',()=>{
 const record=calendarRecord('a','cal',{id:'instance',start:{date:'2026-10-25'},end:{date:'2026-10-26'},recurringEventId:'series',originalStartTime:{date:'2026-10-25'}});
 assert.equal(record.calendar?.startDate,'2026-10-25');assert.equal(record.calendar?.startsAt,null);assert.equal(record.calendar?.recurrenceId,'cal:series');assert.equal(record.calendar?.originalStart,'2026-10-25');
 assert.throws(()=>calendarRecord('a','cal',{id:'bad',start:{date:'2026-02-30'},end:{date:'2026-03-01'}}),/date/);
});
test('calendar timed events honor offsets and timezone instead of server local time',()=>{
 const record=calendarRecord('a','cal',{id:'timed',start:{dateTime:'2026-10-25T09:00:00',timeZone:'America/New_York'},end:{dateTime:'2026-10-25T10:00:00-04:00'}});
 assert.equal(record.calendar?.startsAt,'2026-10-25T13:00:00.000Z');assert.equal(record.calendar?.endsAt,'2026-10-25T14:00:00.000Z');
 assert.equal(calendarRecord('a','cal',{id:'deleted',status:'cancelled'}).deleted,true);
});
test('calendar sync token remains stable through pagination and bounded windows expand recurring instances',async()=>{
 const now=new Date('2026-10-25T12:00:00Z');const calls:Record<string,string|undefined>[]=[];
 const initial=await calendarPage(async(_path,p)=>{calls.push(p!);return {items:[],nextSyncToken:'s1'};},'a','cal',null,30,90,now);
 assert.equal(initial.complete,false);assert.equal(initial.cursor?.phase,'window');assert.equal(calls[0].singleEvents,'false');assert.ok(calls[0].timeMax);
 const snapshot=await calendarPage(async(_path,p)=>{calls.push(p!);return {items:[]};},'a','cal',initial.cursor,30,90,now);
 assert.equal(snapshot.complete,true);assert.equal(calls[1].singleEvents,'true');assert.equal(calls[1].syncToken,undefined);
 const delta=await calendarPage(async(_path,p)=>{calls.push(p!);return {items:[],nextPageToken:'p2'};},'a','cal',snapshot.cursor,30,90,now);
 assert.equal(calls[2].syncToken,'s1');assert.equal(calls[2].timeMin,undefined);assert.equal(delta.cursor?.syncToken,'s1');assert.equal(delta.cursor?.pageToken,'p2');
});
test('expired calendar sync tokens reset explicitly without dropping stored records',async()=>{
 const result=await calendarPage(async()=>{throw new ProviderError('provider_error',410);},'a','cal',{phase:'delta',syncToken:'old',windowStart:'2026-10-01T00:00:00Z',windowEnd:'2027-01-01T00:00:00Z'},30,90);
 assert.equal(result.reset,true);assert.equal(result.cursor?.syncToken,undefined);assert.equal(result.cursor?.resetGap,true);assert.equal(result.coverageComplete,false);
});
