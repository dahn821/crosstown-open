// The persistent record contains request timestamps only, never locations,
// destinations, routes, account identifiers, or provider credentials.
export function communityBudget(storage,{limit=600,windowMs=86400000,now=Date.now,local=false}={}){
 let queue=Promise.resolve();
 return function consume(signal){
  const job=queue.then(async()=>{
   for(let attempt=0;attempt<8;attempt++){
    signal?.throwIfAborted();
    const previous=await storage.getWithMetadata('requests',{type:'json',consistency:'strong'}),cutoff=now()-windowMs;
    signal?.throwIfAborted();
    const times=(previous?.data?.times||[]).filter(time=>Number.isFinite(time)&&time>cutoff);
    if(times.length>=limit)throw Object.assign(Error('The free community routing limit has been reached. Please try again later.'),{status:429});
    times.push(now());
    // Netlify's local Blobs emulator omits the ETag on reads. The production
    // limit requires conditional writes so separate instances share one budget.
    if(previous&&!previous.etag&&!local)throw Object.assign(Error('Routing usage could not be checked. Please try again.'),{status:503});
    const conditions=previous?(previous.etag?{onlyIfMatch:previous.etag}:undefined):{onlyIfNew:true};
    const result=await storage.setJSON('requests',{times},conditions);
    if(result.modified)return;
   }
   throw Object.assign(Error('Routing is busy. Please try again shortly.'),{status:503});
  });queue=job.catch(()=>{});return job;
 };
}
