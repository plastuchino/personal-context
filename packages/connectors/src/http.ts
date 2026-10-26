export class ProviderError extends Error {
 constructor(public code:string, public status:number,public retryAfterSeconds?:number){super(code);}
}
export type ProviderGet=(path:string,params?:Record<string,string|undefined>)=>Promise<any>;
export function providerGet(base:string,accessToken:string,request:typeof fetch=fetch):ProviderGet {
 return async(path,params={})=>{
  const url=new URL(base+path);for(const [key,value]of Object.entries(params))if(value!==undefined)url.searchParams.set(key,value);
  const response=await request(url,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok){
   const raw=response.headers.get('Retry-After');let retry=raw?Number(raw):undefined;
   if(raw&&!Number.isFinite(retry))retry=Math.max(0,(Date.parse(raw)-Date.now())/1000);
   let code=response.status===429?'rate_limited':response.status===401?'reauthorize':`provider_http_${response.status}`;
   // Google also reports rate limits as 403. Retain only fixed operational
   // codes, never the provider's error message or response body.
   if(response.status===403&&['gmail.googleapis.com','www.googleapis.com'].includes(url.hostname)){
    const data=await response.json().catch(()=>null) as {error?:{errors?:{reason?:string}[]}}|null;
    const reasons=Array.isArray(data?.error?.errors)?data.error.errors.map(e=>e?.reason):[];
    if(reasons.some(r=>r==='rateLimitExceeded'||r==='userRateLimitExceeded'))code='rate_limited';
    else if(reasons.includes('dailyLimitExceeded'))code='provider_daily_quota';
    else if(reasons.includes('domainPolicy'))code='provider_domain_policy';
   }
   throw new ProviderError(code,response.status,Number.isFinite(retry)?retry:undefined);
  }
  return response.json();
 };
}
