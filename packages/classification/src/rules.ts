export const RULES_VERSION='personal-v1';
export const WINDOW_MS=7*24*60*60*1000;
export interface Participation {self:number;total:number;coverageComplete:boolean;personal:boolean;reason:'override'|'five-messages'|'participation-ratio'|null}
export function participation(self:number,total:number,override:boolean,coverageComplete:boolean):Participation {
 if(!Number.isSafeInteger(self)||!Number.isSafeInteger(total)||self<0||total<self)throw new Error('Invalid participation counts');
 const reason=override?'override':self>=5?'five-messages':total>0&&self*10>=total?'participation-ratio':null;
 return {self,total,coverageComplete,personal:reason!==null,reason};
}
export function rollingParticipation(messages:{timestamp:string;self:boolean;deleted?:boolean}[],now:Date,override=false,coverageComplete=false):Participation {
 const end=now.getTime(),start=end-WINDOW_MS;
 if(!Number.isFinite(end))throw new Error('Invalid evaluation time');
 const window=messages.filter(m=>!m.deleted&&Date.parse(m.timestamp)>start&&Date.parse(m.timestamp)<=end);
 return participation(window.filter(m=>m.self).length,window.length,override,coverageComplete);
}
