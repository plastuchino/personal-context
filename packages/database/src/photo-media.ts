import {createHash} from 'node:crypto';
import type pg from 'pg';
import {ProviderError} from '../../connectors/src/http.js';
import {photoRecord,type PickedMedia,type PhotoClient} from '../../connectors/src/photos.js';
import {transaction,upsertRecord} from './records.js';
import {fence,queueDerived,type Job} from './jobs.js';
export async function updatePhotoProgress(c:pg.PoolClient,sessionId:string):Promise<void>{
 await c.query(`UPDATE photo_import_sessions SET counts=(SELECT jsonb_build_object('selected',count(*),'downloaded',count(media_asset_id),'analyzed',count(*) FILTER(WHERE status='done'),'failed',count(*) FILTER(WHERE status='failed')) FROM photo_import_items WHERE session_id=$1),
  status=CASE WHEN status IN ('expired','failed') THEN status WHEN EXISTS(SELECT 1 FROM photo_import_items WHERE session_id=$1 AND status='failed') THEN 'failed'
   WHEN NOT EXISTS(SELECT 1 FROM photo_import_items WHERE session_id=$1 AND status<>'done') AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE payload->>'sessionId'=$1::text AND status IN ('queued','running')) THEN 'done' ELSE status END WHERE id=$1`,[sessionId]);
}
export async function downloadPhoto(pool:pg.Pool,job:Job,client:PhotoClient,maxBytes:number):Promise<void>{
 const p=job.payload as {action:string;sessionId:string;recordId:string;item:PickedMedia};
 const selected=(await pool.query(`SELECT i.*,s.provider_session_ref,s.expires_at,r.external_id FROM photo_import_items i JOIN photo_import_sessions s ON s.id=i.session_id JOIN records r ON r.id=i.record_id
  WHERE i.session_id=$1 AND i.record_id=$2 AND s.account_id=$3 AND r.account_id=$3`,[p.sessionId,p.recordId,job.account_id])).rows[0];
 if(!selected||selected.external_id!==p.item.id)throw new Error('Selected photo identity mismatch');
 if(p.item.type==='VIDEO'){
  await transaction(pool,async c=>{
   await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
   const stored=await upsertRecord(c,photoRecord(job.account_id,p.item));
   await c.query("UPDATE photo_import_items SET revision_id=$3,status='done',error_code=NULL WHERE session_id=$1 AND record_id=$2",[p.sessionId,p.recordId,stored.revisionId]);
   await queueDerived(c,job.account_id,p.recordId,stored.revisionId!);
   await c.query("UPDATE sync_jobs SET status='done',error_code=NULL,finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
   await updatePhotoProgress(c,p.sessionId);
  });return;
 }
 if(selected.expires_at.getTime()<=Date.now())throw new ProviderError('photo_selection_expired',410);
 let item=p.item,bytes:Buffer;
 try{bytes=await client.download(item.mediaFile.baseUrl,item.mediaFile.mimeType,maxBytes);}
 catch(error){
  if(!(error instanceof ProviderError&&error.code==='photo_download_expired'))throw error;
  let page:string|undefined;let refreshed:PickedMedia|undefined;
  do{const result=await client.list(selected.provider_session_ref,page);refreshed=result.mediaItems.find(m=>m.id===selected.external_id);page=result.nextPageToken;}while(!refreshed&&page);
  if(!refreshed)throw new ProviderError('photo_selection_expired',410);
  item=refreshed;bytes=await client.download(item.mediaFile.baseUrl,item.mediaFile.mimeType,maxBytes);
 }
 if(!bytes.length||bytes.length>maxBytes)throw new ProviderError('media_too_large',413);
 const sha=createHash('sha256').update(bytes).digest('hex');
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
  const stored=await upsertRecord(c,photoRecord(job.account_id,item,sha));
  if(stored.recordId!==p.recordId)throw new Error('Media record identity mismatch');
  const asset=(await c.query(`INSERT INTO media_assets(record_id,sha256,mime_type,byte_size,bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(record_id,sha256) DO UPDATE SET sha256=excluded.sha256 RETURNING id`,[p.recordId,sha,item.mediaFile.mimeType,bytes.length,bytes])).rows[0].id;
  await c.query('UPDATE photo_details SET media_asset_id=$2 WHERE record_id=$1',[p.recordId,asset]);
  const video=item.type==='VIDEO';
  await c.query('UPDATE photo_import_items SET media_asset_id=$3,revision_id=$4,status=$5 WHERE session_id=$1 AND record_id=$2',[p.sessionId,p.recordId,asset,stored.revisionId,video?'done':'downloaded']);
  if(!video)await c.query(`INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'photo',$3,$4) ON CONFLICT DO NOTHING`,[job.account_id,job.stream_key,`photo-analyze:${p.sessionId}:${stored.revisionId}`,{action:'analyze',sessionId:p.sessionId,recordId:p.recordId,revisionId:stored.revisionId,assetId:asset}]);
  await queueDerived(c,job.account_id,p.recordId,stored.revisionId!);
  await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_until=NULL,lease_token=NULL WHERE id=$1",[job.id]);await updatePhotoProgress(c,p.sessionId);
 });
}
