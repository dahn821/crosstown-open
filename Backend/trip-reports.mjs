const time=value=>{
  const seconds=Number(value?.toString());
  return Number.isFinite(seconds)&&seconds>0?seconds*1000:null;
};

export function stopPrediction(call){
  if(!call?.stopId||[1,2].includes(call.scheduleRelationship))return null;
  const arrival=time(call.arrival?.time),departure=time(call.departure?.time);
  if((arrival==null&&departure==null)||(arrival&&departure&&departure<arrival))return null;
  return {arrival:arrival??departure,departure:departure??arrival};
}

export function tripReportTime(update,entry){
  return time(update?.timestamp)??entry.sourceTimestamp;
}
export const freshPrediction=(timestamp,now)=>Number.isFinite(timestamp)&&timestamp>=now-180000&&timestamp<=now+120000;
export const canceledTrip=entity=>!!entity?.isDeleted||[3,7].includes(entity?.tripUpdate?.trip?.scheduleRelationship);
export const duePrediction=(prediction,now)=>prediction.departure>=now&&prediction.arrival<now+60000;

export function upcomingPredictions(update,now,horizon=90*60000){
  return (update?.stopTimeUpdate||[]).flatMap((call,index)=>{
    const prediction=stopPrediction(call);
    return prediction&&prediction.departure>=now&&prediction.arrival<=now+horizon?
      [{...prediction,stopId:call.stopId,index}]:[];
  });
}

export function positionReportTime(vehicle,now){
  const reported=time(vehicle?.timestamp);
  return reported!=null&&reported>=now-90000&&reported<=now+30000?reported:null;
}

export function trackingId(feed,trip){
  if(!trip?.tripId)return undefined;
  return Buffer.from(JSON.stringify([feed,trip.tripId,trip.startDate||''])).toString('base64url');
}

export function trackingQuery(params,feeds){
  const id=params.get('id');
  const invalid=()=>Object.assign(Error('Choose a current bus or train.'),{status:400});
  if(!id||id.length>640||!/^[\w-]+$/.test(id))throw invalid();
  let value;
  try{value=JSON.parse(Buffer.from(id,'base64url').toString('utf8'));}catch{throw invalid();}
  if(!Array.isArray(value)||value.length!==3)throw invalid();
  const [feed,tripId,startDate]=value;
  if(!feeds.includes(feed)||typeof tripId!=='string'||!tripId.trim()||tripId.length>240||/[\x00-\x1f]/.test(tripId)||
      typeof startDate!=='string'||!/^(?:\d{8})?$/.test(startDate)||id!==trackingId(feed,{tripId,startDate}))throw invalid();
  return {feed,tripId,startDate,id};
}

export function indexTripUpdates(entry){
  const index=new Map();
  for(const entity of entry?.message?.entity||[]){
    const trip=entity.tripUpdate?.trip;if(!trip?.tripId)continue;
    if(!index.has(trip.tripId))index.set(trip.tripId,new Map());
    index.get(trip.tripId).set(trip.startDate||'',entity);
  }
  return index;
}

export function findTripUpdate(index,{tripId,startDate},accept=()=>true){
  const candidates=index.get(tripId);
  const exact=candidates?.get(startDate||'');
  if(exact&&accept(exact.tripUpdate.trip))return exact;
  const compatible=[...(candidates?.values()||[])].filter(entity=>{
    const trip=entity.tripUpdate.trip;
    return (!startDate||!trip.startDate)&&accept(trip);
  });
  return compatible.length===1?compatible[0]:null;
}
