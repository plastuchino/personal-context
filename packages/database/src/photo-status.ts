import type pg from 'pg';
import type {EmbeddingConfig} from './indexing.js';
export async function photoStatus(pool:pg.Pool,config:EmbeddingConfig|null,sessionId?:string,sessionIds?:string[]) {
 const model=config?(await pool.query('SELECT id FROM embedding_models WHERE provider=$1 AND model_name=$2 AND version=$3 AND dimensions=$4',[config.adapter??'gateway',config.model,config.version,config.dimensions])).rows[0]?.id:null;
 return (await pool.query(`SELECT s.id,s.account_id,s.created_at,s.status,s.expires_at,s.error_code,$2::boolean AS embedding_model_configured,
 (SELECT jsonb_build_object('selected',count(*),'downloaded',count(media_asset_id),'analyzed',count(*) FILTER(WHERE status='done'),'failed',count(*) FILTER(WHERE status='failed')) FROM photo_import_items WHERE session_id=s.id)||jsonb_build_object(
 'metadata_only',(SELECT count(*) FROM photo_import_items i JOIN records r ON r.id=i.record_id WHERE i.session_id=s.id AND i.status='done' AND r.kind='video'),
 'keyword_indexed',(SELECT count(*) FROM photo_import_items i WHERE i.session_id=s.id AND EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=i.revision_id)),
 'classified',(SELECT count(*) FROM photo_import_items i JOIN records r ON r.id=i.record_id WHERE i.session_id=s.id AND EXISTS(SELECT 1 FROM classification_runs cr WHERE cr.record_id=i.record_id AND cr.revision_id=i.revision_id AND cr.context_version=r.context_version AND cr.status='done')),
 'embedded',(SELECT count(*) FROM photo_import_items i WHERE i.session_id=s.id AND EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=i.revision_id) AND NOT EXISTS(SELECT 1 FROM record_chunks c WHERE c.revision_id=i.revision_id AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=c.id AND e.embedding_model_id=$1)))) AS counts
 FROM (SELECT * FROM photo_import_sessions WHERE ($3::uuid IS NULL OR id=$3) AND ($4::uuid[] IS NULL OR id=ANY($4)) ORDER BY created_at DESC,id DESC LIMIT 50) s ORDER BY s.created_at DESC,s.id DESC`,[model??null,Boolean(config),sessionId??null,sessionIds??null])).rows;
}
