import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,20);
const stop=id=>String(id??'').split(':').at(-1);
const transit=leg=>leg.mode==='subway'||leg.mode==='bus';
const endpoint=place=>place.stop?.gtfsId||place.vehicleRentalStation?.stationId||`${place.lat?.toFixed(5)},${place.lon?.toFixed(5)}`;
export function corridorKey(raw){
  return raw.legs.map((leg,i)=>[leg.mode,leg.mode==='BUS'?leg.route?.shortName:'',i===0&&!['SUBWAY','BUS'].includes(leg.mode)?'origin':endpoint(leg.from),i===raw.legs.length-1&&!['SUBWAY','BUS'].includes(leg.mode)?'destination':endpoint(leg.to),Boolean(leg.rentedBike)].join(':')).join('|');
}
export function choiceID(route,groupId){
  return 'train-'+hash(groupId+'|'+route.legs.filter(transit).map(leg=>[leg.line,leg.tripId||leg.departureTime,leg.from.id,leg.to.id].join(':')).join('|'));
}

export function predictionSnapshot(store){
  const snapshot=Object.create(store),cache=new Map();
  snapshot.connections=query=>{
    const {readyAt=-Infinity,latestArrival=Infinity,earliestArrival=-Infinity,tripId,...pair}=query,key=JSON.stringify(pair);
    if(!cache.has(key))cache.set(key,store.connections({...pair,readyAt:-Infinity}));
    return cache.get(key).filter(item=>(!tripId||item.tripId===tripId)&&item.departure>=readyAt&&item.arrival<=latestArrival&&item.arrival>=earliestArrival).sort((a,b)=>Number.isFinite(latestArrival)?b.departure-a.departure||a.arrival-b.arrival:a.arrival-b.arrival);
  };
  snapshot.connection=query=>snapshot.connections(query)[0]||null;
  return snapshot;
}

// Each departure is a complete forwards-validated itinerary, including every
// downstream transfer, walking limit, fare limit, and any arrival deadline.
export function subwayOptions(pairs,request,store,{normalize,rank,primaryTransitMode=()=>undefined,geometry=()=>null}={}){
  const grouped=new Map(),alternativeRoutes={},primaries=[],transitCandidates={subway:[],bus:[]};
  const pick=routes=>rank(routes,request.preferences)[0];

  function representative(routes,groupId){
    const best=pick(routes);
    if(!groupId)return best;

    const byChoice=new Map();
    for(const route of routes){
      const id=choiceID(route,groupId),previous=byChoice.get(id);
      byChoice.set(id,previous?pick([route,previous]):route);
    }
    const ordered=[...byChoice].sort((a,b)=>Date.parse(a[1].legs.find(transit)?.departureTime)-Date.parse(b[1].legs.find(transit)?.departureTime)||a[1].minutes-b[1].minutes);
    const selected=new Map([[choiceID(best,groupId),best]]),lineSets=new Set();
    for(const [id,route] of ordered){const lines=route.legs.filter(transit).map(leg=>leg.line).join('|');if(!lineSets.has(lines)){selected.set(id,route);lineSets.add(lines);}}
    for(const [id,route] of ordered){if(selected.size>=32)break;selected.set(id,route);}
    const ids=[...selected.keys()];
    const lineOptions=best.legs.map((leg,index)=>leg.mode==='subway'?[...new Map([...selected.values()].map(route=>route.legs[index]).map(item=>[item.line,{line:item.line,routeColor:item.routeColor}])).values()].sort((a,b)=>a.line.localeCompare(b.line,undefined,{numeric:true})):null);
    const decorate=(route,id)=>({...route,id,groupId,choiceId:choiceID(route,groupId),alternativeIds:ids,legs:route.legs.map((leg,index)=>lineOptions[index]?{...leg,lineOptions:lineOptions[index]}:leg)});
    for(const [id,route] of selected)alternativeRoutes[id]=decorate(route,id);
    return decorate(best,groupId);
  }

  function record(routes,groupId){
    const best=representative(routes,groupId);
    primaries.push(best);
    for(const [mode,candidates] of Object.entries(transitCandidates)){
      const eligible=routes.filter(route=>primaryTransitMode(route)===mode);
      if(!eligible.length)continue;
      // Unrestricted choices can include another train that changes the main
      // mode of a mixed itinerary. Keep that choice in Best only.
      const scopedId=groupId?`${groupId}-${mode}`:undefined;
      candidates.push(eligible.length===routes.length?best:representative(eligible,scopedId));
    }
  }

  for(const pair of pairs){const key=corridorKey(pair.raw);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(pair);}
  for(const [key,group] of grouped){
    const base=group[0].raw;
    if(!base.legs.some(leg=>leg.mode==='SUBWAY')){record(group.map(pair=>pair.route));continue;}
    const groupId='corridor-'+hash(key),choices=new Map();
    function add(route,raw){
      const id=choiceID(route,groupId)+'|'+(primaryTransitMode(route)||'');
      const previous=choices.get(id);
      if(!previous||pick([route,previous.route])===route)choices.set(id,{route,raw});
    }
    for(const pair of group)add(pair.route,pair.raw);
    for(let i=0;i<base.legs.length;i++){
      if(base.legs[i].mode!=='SUBWAY')continue;
      const seeds=[...choices.values()].sort((a,b)=>a.route.minutes-b.route.minutes).slice(0,16);
      for(const seed of seeds){
      const leg=seed.raw.legs[i];
      const connections=store.connections({fromStop:stop(leg.from.stop?.gtfsId),toStop:stop(leg.to.stop?.gtfsId),readyAt:request.depart,latestArrival:request.arriveBy??request.depart+90*60000,kind:'subway'}).sort((a,b)=>a.departure-b.departure||a.arrival-b.arrival),perLine=new Map();
      for(const connection of connections){
        if(!connection.tripId)continue;
        const seen=perLine.get(connection.line)||0;if(seen>=3)continue;
        const coordinates=geometry(connection);
        const legs=seed.raw.legs.map((item,index)=>index===i?{...item,pinnedTripId:connection.tripId,route:{...item.route,shortName:connection.line,color:store.tripIndex?.routes?.[connection.line]?.route_color||null},headsign:'',...(coordinates?.length>1?{coordinates,legGeometry:undefined}:{}),stopCalls:connection.stopIds.map(id=>({stopLocation:{gtfsId:'nyct:'+id}}))}:item);
        const option=normalize({legs},request,store);if(!option)continue;
        perLine.set(connection.line,seen+1);add(option,{legs});
      }
      }
    }
    record([...choices.values()].map(choice=>choice.route),groupId);
  }
  return {primaries,alternativeRoutes,transitCandidates};
}
