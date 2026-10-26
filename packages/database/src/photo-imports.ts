import type pg from 'pg';
import {durationMs,photoRecord,type PhotoClient} from '../../connectors/src/photos.js';
import {transaction,upsertRecord} from './records.js';
import {fence,type Job} from './jobs.js';
export async function createPhotoImport(pool:pg.Pool,accountId:string,client:PhotoClient):Promise<{id:string;picker_uri:string;expires_at:string}>{
 if(!(await pool.query("SELECT 1 FROM source_accounts WHERE id=$1 AND provider='google-photos' AND status='active'",[accountId])).rowCount)throw new Error('Active Photos connection required');
 const session=await client.create();
 const expiry=Date.parse(session.expireTime);if(!session.id||!session.pickerUri||!Number.isFinite(expiry)||expiry<=Date.now())throw new Error('Invalid Picker session');
 const interval=durationMs(session.pollingConfig?.pollInterval,5000);
 const deadline=new Date(Math.min(expiry,Date.now()+durationMs(session.pollingConfig?.timeoutIn,expiry-Date.now()))).toISOString();
 return transaction(pool,async c=>{
  const row=(await c.query(`INSERT INTO photo_import_sessions(account_id,provider_session_ref,status,expires_at,picker_uri,poll_interval_ms,polling_deadline_at)
   VALUES($1,$2,'selecting',$3,$4,$5,$6) RETURNING id`,[accountId,session.id,session.expireTime,session.pickerUri,interval,deadline])).rows[0];
  const stream=`photos:${row.id}`;await c.query('INSERT INTO sync_state(account_id,stream_key) VALUES($1,$2)',[accountId,stream]);
  await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload,scheduled_at) VALUES($1,$2,'photo',$3,$4,now()+make_interval(secs=>$5))`,[accountId,stream,`photo-select:${row.id}`,{action:'poll',sessionId:row.id},interval/1000]);
  return {id:row.id,picker_uri:session.pickerUri,expires_at:session.expireTime};
 });
}
export async function selectionStep(pool:pg.Pool,job:Job,client:PhotoClient):Promise<boolean>{
 const payload=job.payload as {sessionId:string;action:string;pageToken?:string};
 const session=(await pool.query('SELECT * FROM photo_import_sessions WHERE id=$1 AND account_id=$2',[payload.sessionId,job.account_id])).rows[0];
 if(!session)throw new Error('Photo import account mismatch');
 if(session.expires_at.getTime()<=Date.now()||(payload.action==='poll'&&session.polling_deadline_at?.getTime()<=Date.now())){
  await transaction(pool,async c=>{await fence(c,job);await c.query("UPDATE photo_import_sessions SET status='expired',error_code='photo_selection_expired' WHERE id=$1",[session.id]);await c.query("UPDATE sync_jobs SET status='failed',finished_at=now(),error_code='photo_selection_expired',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);});return true;
 }
 if(payload.action==='poll'){
  const state=await client.get(session.provider_session_ref);
  await transaction(pool,async c=>{
   await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
   if(state.mediaItemsSet){
    await c.query("UPDATE photo_import_sessions SET status='importing' WHERE id=$1",[session.id]);
    await c.query("UPDATE sync_jobs SET payload=$2 WHERE id=$1",[job.id,{action:'import',sessionId:session.id}]);
   }else await c.query("UPDATE sync_jobs SET status='queued',attempt=0,scheduled_at=now()+make_interval(secs=>$2),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id,durationMs(state.pollingConfig?.pollInterval,session.poll_interval_ms)/1000]);
  });
  if(state.mediaItemsSet){job.payload={action:'import',sessionId:session.id};return false;}return true;
 }
 if(payload.action!=='import'||session.status!=='importing')throw new Error('Selection must finish before media listing');
 const page=await client.list(session.provider_session_ref,payload.pageToken);
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
  for(const item of page.mediaItems){
   const prior=(await c.query(`SELECT a.sha256 FROM records r JOIN photo_details p ON p.record_id=r.id JOIN media_assets a ON a.id=p.media_asset_id WHERE r.account_id=$1 AND r.external_id=$2 AND r.kind=$3`,[job.account_id,item.id,item.type==='VIDEO'?'video':'photo'])).rows[0];
   const stored=await upsertRecord(c,photoRecord(job.account_id,item,prior?.sha256));
   await c.query(`INSERT INTO photo_import_items(session_id,record_id,revision_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[session.id,stored.recordId,stored.revisionId]);
   await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'photo',$3,$4) ON CONFLICT DO NOTHING`,[job.account_id,job.stream_key,`photo-download:${session.id}:${stored.recordId}`,{action:'download',sessionId:session.id,recordId:stored.recordId,item}]);
  }
  if(page.nextPageToken){job.payload={action:'import',sessionId:session.id,pageToken:page.nextPageToken};await c.query('UPDATE sync_jobs SET payload=$2 WHERE id=$1',[job.id,job.payload]);}
  else{
   await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
   if(!page.mediaItems.length&&!(await c.query('SELECT 1 FROM photo_import_items WHERE session_id=$1',[session.id])).rowCount)await c.query("UPDATE photo_import_sessions SET status='done' WHERE id=$1",[session.id]);
  }
 });return !page.nextPageToken;
}
