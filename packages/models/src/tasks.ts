export interface ExtractedRequest {title:string;description:string;quote:string;due_at:string|null;existing_task_id:string|null}
export interface ExtractedResolution {task_id:string;quote:string;status:'done'|'uncertain'}
export interface TaskExtraction {requests:ExtractedRequest[];resolutions:ExtractedResolution[]}
export const taskSchema={type:'object',additionalProperties:false,required:['requests','resolutions'],properties:{requests:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['title','description','quote','due_at','existing_task_id'],properties:{title:{type:'string'},description:{type:'string'},quote:{type:'string'},due_at:{type:['string','null']},existing_task_id:{type:['string','null']}}}},resolutions:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['task_id','quote','status'],properties:{task_id:{type:'string'},quote:{type:'string'},status:{type:'string',enum:['done','uncertain']}}}}}};
export function validateTasks(value:unknown):TaskExtraction {
 if(!value||typeof value!=='object')throw new Error('Invalid task extraction');
 const data=value as TaskExtraction;const text=(s:unknown,max=4000)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
 const id=(s:unknown)=>typeof s==='string'&&/^[a-f0-9-]{36}$/i.test(s);
 if(!Array.isArray(data.requests)||!Array.isArray(data.resolutions)||data.requests.length>20||data.resolutions.length>20)throw new Error('Invalid task extraction');
 for(const r of data.requests)if(!r||!text(r.title,300)||!text(r.description)||!text(r.quote)||!(r.existing_task_id===null||id(r.existing_task_id))||!(r.due_at===null||typeof r.due_at==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(r.due_at)&&Number.isFinite(Date.parse(r.due_at))))throw new Error('Invalid extracted request');
 for(const r of data.resolutions)if(!r||!id(r.task_id)||!text(r.quote)||!['done','uncertain'].includes(r.status))throw new Error('Invalid extracted resolution');
 return data;
}

export function taskSchemaFor(text:string):unknown {
 let ids:string[]=[];
 try{const data=JSON.parse(text);ids=(Array.isArray(data.related_tasks)?data.related_tasks:[]).map((t:{id?:unknown})=>t.id).filter((id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id));}catch{}
 const schema=structuredClone(taskSchema);
 return {...schema,properties:{...schema.properties,
  requests:{...schema.properties.requests,items:{...schema.properties.requests.items,properties:{...schema.properties.requests.items.properties,existing_task_id:{enum:[null,...ids]}}}},
  resolutions:{...schema.properties.resolutions,maxItems:ids.length?20:0,items:{...schema.properties.resolutions.items,properties:{...schema.properties.resolutions.items.properties,task_id:{type:'string',enum:ids.length?ids:['no-existing-tasks']}}}}
 }};
}
