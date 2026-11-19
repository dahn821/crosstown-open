export function canChooseDeparture(route,now=Date.now()){
  const first=route.legs.findIndex(leg=>leg.mode==='subway'||leg.mode==='bus');if(first<0)return false;
  const access=route.legs.slice(0,first).reduce((sum,leg)=>sum+leg.duration,0)*60000;
  if(Date.parse(route.legs[first].departureTime)<Math.max(now,Date.parse(route.departureTime))+access+45000)return false;
  return route.legs.every(leg=>!leg.realtime||(Number.isFinite(Date.parse(leg.predictionReportedAt))&&now-Date.parse(leg.predictionReportedAt)<=180000));
}
export function departureOptions(route,index,response,now=Date.now()){
  const seen=new Set();
  return (route.alternativeIds||[]).map(id=>response?.alternativeRoutes?.[id]).filter(option=>{
    if(!option||option.legs[index]?.mode!=='subway'||!canChooseDeparture(option,now))return false;
    for(let i=0;i<index;i++)if(['subway','bus'].includes(route.legs[i].mode)&&(route.legs[i].tripId||route.legs[i].departureTime)!==(option.legs[i]?.tripId||option.legs[i]?.departureTime))return false;
    const key=option.legs[index].tripId||option.legs[index].line+'|'+option.legs[index].departureTime;
    if(seen.has(key))return false;seen.add(key);return true;
  }).sort((a,b)=>Date.parse(a.legs[index].departureTime)-Date.parse(b.legs[index].departureTime)||a.minutes-b.minutes);
}
export function resolveDeparture(route,response,selections){
  const id=selections[route.groupId||route.id],option=response?.alternativeRoutes?.[id];
  return option&&route.alternativeIds?.includes(id)?{...option,id:route.id}:route;
}
