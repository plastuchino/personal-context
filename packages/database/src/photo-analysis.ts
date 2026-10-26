import type pg from 'pg';
import type {ModelAdapters} from '../../models/src/index.js';
import {ProviderError} from '../../connectors/src/http.js';
import {transaction} from './records.js';
import {fence,queueDerived,type Job} from './jobs.js';
import {updatePhotoProgress} from './photo-media.js';
export async function analyzePhoto(pool:pg.Pool,job:Job,models:Pick<ModelAdapters,'describe'>,modelVersion:string|null):Promise<void>{
 if(!modelVersion)throw new ProviderError('photo_model_unconfigured',503);
 const p=job.payload as {sessionId:string;recordId:string;revisionId:string;assetId:string};
 const asset=(await pool.query(`SELECT a.bytes,a.mime_type FROM photo_import_items i JOIN photo_import_sessions s ON s.id=i.session_id JOIN media_assets a ON a.id=i.media_asset_id AND a.record_id=i.record_id
  WHERE i.session_id=$1 AND i.record_id=$2 AND i.revision_id=$3 AND a.id=$4 AND s.account_id=$5`,[p.sessionId,p.recordId,p.revisionId,p.assetId,job.account_id])).rows[0];
 if(!asset)throw new Error('Photo analysis artifact mismatch');
 const already=(await pool.query("SELECT 1 FROM derived_content WHERE revision_id=$1 AND kind='description' AND model_version=$2",[p.revisionId,modelVersion])).rowCount;
 const result=already?null:await models.describe({mimeType:asset.mime_type,base64:asset.bytes.toString('base64')});
 await transaction(pool,async c=>{
  await c.query('SELECT 1 FROM sync_state WHERE account_id=$1 AND stream_key=$2 FOR UPDATE',[job.account_id,job.stream_key]);await fence(c,job);
  if(result)for(const [kind,text]of [['description',result.description],['ocr',result.ocr]])await c.query(`INSERT INTO derived_content(revision_id,kind,text,model_version) VALUES($1,$2,$3,$4) ON CONFLICT(revision_id,kind,model_version) DO NOTHING`,[p.revisionId,kind,text,modelVersion]);
  await queueDerived(c,job.account_id,p.recordId,p.revisionId,`:photo:${modelVersion}`);
  await c.query("UPDATE photo_import_items SET status='done',error_code=NULL WHERE session_id=$1 AND record_id=$2",[p.sessionId,p.recordId]);
  await c.query("UPDATE sync_jobs SET status='done',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  await updatePhotoProgress(c,p.sessionId);
 });
}
export async function recordPhotoFailure(pool:pg.Pool,job:Job,code:string):Promise<void>{
 if(!/^[a-z0-9_]{1,80}$/.test(code))throw new Error('Use a redacted photo error code');
 const p=job.payload as {sessionId:string;recordId?:string};
 await transaction(pool,async c=>{
  const state=(await c.query('SELECT status FROM sync_jobs WHERE id=$1 AND account_id=$2',[job.id,job.account_id])).rows[0];
  const expired=code==='photo_selection_expired';
  if(expired)await c.query("UPDATE sync_jobs SET status='failed',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  const terminal=expired||state?.status==='failed';
  await c.query(`UPDATE photo_import_sessions SET error_code=$3,status=CASE WHEN $4 THEN $5 ELSE status END WHERE id=$1 AND account_id=$2`,[p.sessionId,job.account_id,code,terminal,expired?'expired':'failed']);
  if(p.recordId&&terminal)await c.query("UPDATE photo_import_items SET status='failed',error_code=$3 WHERE session_id=$1 AND record_id=$2",[p.sessionId,p.recordId,code]);
  await updatePhotoProgress(c,p.sessionId);
 });
}
