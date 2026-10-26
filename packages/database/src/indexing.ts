import type pg from 'pg';
import type {Config} from '@personal-context/config';
import type {ModelAdapters} from '../../models/src/index.js';
import {chunkText,sourceText} from '../../retrieval/src/chunks.js';
import {transaction} from './records.js';
import {fence,type Job} from './jobs.js';
import {finishJob} from './classification.js';
import {ProviderError} from '../../connectors/src/http.js';
export type EmbeddingConfig=NonNullable<Config['embedding']>;
export async function embeddingModel(db:pg.Pool|pg.PoolClient,config:EmbeddingConfig):Promise<string> {
 const row=(await db.query(`INSERT INTO embedding_models(provider,model_name,version,dimensions) VALUES($1,$2,$3,$4)
 ON CONFLICT(provider,model_name,version) DO UPDATE SET model_name=excluded.model_name RETURNING id,dimensions`,[config.adapter??'gateway',config.model,config.version,config.dimensions])).rows[0];
 if(row.dimensions!==config.dimensions)throw new Error('Pinned embedding model dimension mismatch');
 return row.id;
}
export async function ensureVectorIndex(pool:pg.Pool,config:EmbeddingConfig):Promise<string> {
 const id=await embeddingModel(pool,config);
 if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(config.dimensions)||config.dimensions<1||config.dimensions>2000)throw new Error('Invalid embedding index identity');
 // Identifiers derive only from validated database UUID and validated dimension.
 await pool.query(`CREATE INDEX IF NOT EXISTS embedding_${id.replaceAll('-','')} ON chunk_embeddings USING hnsw ((embedding::vector(${config.dimensions})) vector_cosine_ops) WHERE embedding_model_id='${id}'::uuid`);
 return id;
}
export async function indexJob(pool:pg.Pool,job:Job,models:Pick<ModelAdapters,'embed'>,config:EmbeddingConfig|null):Promise<void> {
 const p=job.payload as {recordId:string;revisionId?:string};
 const chunks=await transaction(pool,async db=>{
  await fence(db,job);
  const record=(await db.query(`SELECT r.id,r.kind,r.external_id,r.current_revision_id,v.title,v.body_text,v.raw_payload FROM records r JOIN record_revisions v ON v.id=r.current_revision_id WHERE r.id=$1 AND r.account_id=$2 AND r.deleted_at IS NULL FOR UPDATE OF r`,[p.recordId,job.account_id])).rows[0];
  if(!record||(p.revisionId&&record.current_revision_id!==p.revisionId)){await finishJob(db,job);return null;}
  const base=sourceText(record);
  const texts=[{key:'source',kind:base.kind,content:base.text,derived:null as string|null,version:null as string|null},...(await db.query('SELECT id,kind,text,model_version FROM derived_content WHERE revision_id=$1 ORDER BY id',[record.current_revision_id])).rows.map(d=>({key:`derived:${d.id}`,kind:d.kind,content:d.text,derived:d.id,version:d.model_version}))];
  let chunkIndex=(await db.query('SELECT coalesce(max(chunk_index),-1)::int AS n FROM record_chunks WHERE revision_id=$1',[record.current_revision_id])).rows[0].n+1;
  for(const text of texts){
   const inserted=(await db.query('INSERT INTO index_sources(revision_id,source_key,kind,content,derived_content_id,model_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[record.current_revision_id,text.key,text.kind,text.content,text.derived,text.version])).rows[0];
   if(!inserted)continue;
   for(const part of chunkText(text.content))await db.query('INSERT INTO record_chunks(revision_id,derived_content_id,chunk_index,content,start_offset,end_offset,source_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[record.current_revision_id,text.derived,chunkIndex++,part.content,part.start,part.end,inserted.id]);
  }
  return (await db.query('SELECT id,content FROM record_chunks WHERE revision_id=$1 ORDER BY chunk_index',[record.current_revision_id])).rows as {id:string;content:string}[];
 });
 if(!chunks)return;
 if(!config)throw new ProviderError('embedding_model_unconfigured',503);
 const modelId=await embeddingModel(pool,config);
 const pending=(await pool.query('SELECT id,content FROM record_chunks WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=record_chunks.id AND e.embedding_model_id=$2) ORDER BY chunk_index',[chunks.map(c=>c.id),modelId])).rows;
 // Bounded batches avoid overflowing local model memory on long records.
 for(let offset=0;offset<pending.length;offset+=16){
  const batch=pending.slice(offset,offset+16),vectors=await models.embed(batch.map(c=>c.content));
  if(vectors.length!==batch.length||vectors.some(v=>v.length!==config.dimensions||!v.every(Number.isFinite)||!v.some(x=>x!==0)))throw new Error('Embedding dimension mismatch');
  await transaction(pool,async db=>{await fence(db,job);for(let n=0;n<batch.length;n++)await db.query('INSERT INTO chunk_embeddings(chunk_id,embedding_model_id,dimensions,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING',[batch[n].id,modelId,config.dimensions,JSON.stringify(vectors[n])]);});
 }
 await transaction(pool,async db=>{await fence(db,job);await finishJob(db,job);});
}
export async function scheduleIndexes(pool:pg.Pool,config:EmbeddingConfig|null,accountId?:string):Promise<number> {
 const modelId=config?await embeddingModel(pool,config):null;
 return transaction(pool,async db=>{
  const rows=(await db.query(`SELECT r.id,r.account_id,r.current_revision_id,
   md5(coalesce((SELECT string_agg(d.id::text,',' ORDER BY d.id) FROM derived_content d WHERE d.revision_id=r.current_revision_id),'')) AS derived_hash
   FROM records r WHERE r.deleted_at IS NULL AND r.current_revision_id IS NOT NULL AND ($2::uuid IS NULL OR r.account_id=$2) AND (
    NOT EXISTS(SELECT 1 FROM index_sources s WHERE s.revision_id=r.current_revision_id AND s.source_key='source') OR
    EXISTS(SELECT 1 FROM derived_content d WHERE d.revision_id=r.current_revision_id AND NOT EXISTS(SELECT 1 FROM index_sources s WHERE s.derived_content_id=d.id)) OR
    ($1::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=r.current_revision_id AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=c.id AND e.embedding_model_id=$1)))
   ) AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.stage='embed' AND j.payload->>'recordId'=r.id::text AND j.status IN ('queued','running'))
   ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 100`,[modelId,accountId??null])).rows;
  let count=0;
  for(const row of rows){
   const key=`embed:${row.current_revision_id}:${row.derived_hash}:${modelId??'unconfigured'}`;
   if((await db.query('SELECT 1 FROM sync_jobs WHERE dedupe_key=$1',[key])).rowCount)continue;
   const stream=`derived:${row.id}`;await db.query('INSERT INTO sync_state(account_id,stream_key,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING',[row.account_id,stream]);
   count+=(await db.query("INSERT INTO sync_jobs(account_id,stream_key,stage,dedupe_key,payload) VALUES($1,$2,'embed',$3,$4) ON CONFLICT DO NOTHING",[row.account_id,stream,key,{recordId:row.id,revisionId:row.current_revision_id}])).rowCount??0;
  }
  return count;
 });
}
