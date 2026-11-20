const streamType='application/x-ndjson';

export async function searchRoutes(request,{signal,onPreview}={}){
  const response=await fetch('/api/plan',{
    method:'POST',body:JSON.stringify(request),signal,
    headers:{'Content-Type':'application/json',Accept:onPreview?`${streamType}, application/json`:'application/json'}
  });
  if(!response.ok||!response.headers.get('content-type')?.includes(streamType)||!response.body){
    const plan=await response.json();
    if(!response.ok)throw Error(plan.error||'The route search could not be completed.');
    return plan;
  }

  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending='';
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      pending+=value;
      const lines=pending.split('\n');
      pending=lines.pop();
      for(const line of lines){
        if(!line)continue;
        const event=JSON.parse(line);
        if(event.type==='error')throw Error(event.error||'The route search could not be completed.');
        if(event.type==='preview'&&event.route)onPreview?.(event.route);
        if(event.type==='result'&&event.plan)return event.plan;
      }
    }
    throw Error('The route search ended early. Try again.');
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
