export interface TextChunk {content:string;start:number;end:number}
function boundary(text:string,index:number):number {return index>0&&index<text.length&&text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff?index-1:index;}
export function chunkText(text:string,size=1400,overlap=160):TextChunk[] {
 if(!Number.isInteger(size)||size<32||!Number.isInteger(overlap)||overlap<0||overlap>=size/2)throw new Error('Invalid chunk bounds');
 const result:TextChunk[]=[];let start=0;
 while(start<text.length){
  let end=boundary(text,Math.min(start+size,text.length));
  if(end<text.length){const paragraph=text.lastIndexOf('\n',end),word=text.lastIndexOf(' ',end);const split=paragraph>start+size/2?paragraph+1:word>start+size/2?word+1:end;end=boundary(text,split);}
  const content=text.slice(start,end);if(content.trim())result.push({content,start,end});
  if(end===text.length)break;start=boundary(text,Math.max(start+1,end-overlap));
 }
 return result;
}
export function sourceText(record:{kind:string;external_id:string;title:string;body_text:string;raw_payload:unknown}):{text:string;kind:'source'|'structured'} {
 const text=[record.title,record.body_text].filter(x=>x.trim()).join('\n');
 return text.trim()?{text,kind:'source'}:{text:JSON.stringify({kind:record.kind,source_id:record.external_id,fields:record.raw_payload}),kind:'structured'};
}
