import {subwayFeeds} from './feeds.mjs';

const stopID=place=>String(place.stop?.gtfsId||'').split(':').at(-1);
const slack=90000;
const milliseconds=event=>Number(event?.time?.toString()||0)*1000;

export function createSubwayTransferSearch(store,request){
  const stops=store.tripIndex?.stops||{},departures=new Map();
  const last=request.arriveBy??request.depart+90*60000;
  for(const feed of subwayFeeds){
    if(store.freshness(feed).stale)continue;
    for(const entity of store.entries.get(feed)?.message?.entity||[]){
      const update=entity.tripUpdate,trip=update?.trip;
      if(entity.isDeleted||!trip?.tripId||!trip.routeId||[3,7].includes(trip.scheduleRelationship))continue;
      const calls=(update.stopTimeUpdate||[]).filter(call=>![1,2].includes(call.scheduleRelationship)).map(call=>({
        stop:call.stopId,arrival:milliseconds(call.arrival||call.departure),departure:milliseconds(call.departure||call.arrival)
      }));
      for(const [index,call] of calls.entries()){
        if(index===calls.length-1||call.departure<request.depart||call.departure>=last)continue;
        if(!departures.has(call.stop))departures.set(call.stop,[]);
        departures.get(call.stop).push({trip,calls,index,departure:call.departure});
      }
    }
  }

  function rawSegment(segment,leg,fromId,toId){
    const {trip,calls,index,end}=segment;
    const place=id=>{
      if(id===fromId)return leg.from;
      if(id===toId)return leg.to;
      const stop=stops[id];
      return {name:stop.name,lat:stop.latitude,lon:stop.longitude,stop:{gtfsId:'nyct:'+id}};
    };
    const stopIds=calls.slice(index,end+1).map(call=>call.stop);
    return {
      id:trip.tripId+'@'+calls[index].stop,mode:'SUBWAY',
      from:place(calls[index].stop),to:place(calls[end].stop),
      duration:(calls[end].arrival-calls[index].departure)/1000,
      route:{shortName:trip.routeId,color:store.tripIndex.routes?.[trip.routeId]?.route_color},
      pinnedTripId:trip.tripId,
      coordinates:stopIds.map(id=>stops[id]).filter(Boolean).map(stop=>({latitude:stop.latitude,longitude:stop.longitude})),
      stopCalls:stopIds.map(id=>({stopLocation:{gtfsId:'nyct:'+id}}))
    };
  }

  return function connections(leg,readyAt,arriveBefore,maxExtraTransfers){
    const fromId=stopID(leg.from),toId=stopID(leg.to);
    if(!departures.has(fromId)||!stops[toId]||readyAt>=arriveBefore)return [];
    // Transfers must share an in-service directional platform on this corridor.
    // Keep the base route's direct stop pattern and others serving both ends.
    const through=store.connections({fromStop:fromId,toStop:toId,readyAt,latestArrival:last,kind:'subway'});
    const allowed=new Set([
      ...(leg.stopCalls||[]).map(call=>call.stopLocation?.gtfsId?.split(':').at(-1)),
      ...through.flatMap(connection=>connection.stopIds)
    ].filter(id=>id!==fromId&&id!==toId&&stops[id]));
    if(!allowed.size)return [];
    let round=[{stop:fromId,readyAt,segments:[]}];
    const alternatives=[];
    for(let rides=1;rides<=Math.min(3,1+maxExtraTransfers)&&round.length;rides++){
      const next=new Map(),arrivals=new Map();
      for(const previous of round){
        for(const boarding of departures.get(previous.stop)||[]){
          const {trip,calls,index,departure}=boarding;
          if(departure<previous.readyAt||departure>=arriveBefore||trip.routeId===previous.line)continue;
          const firstDeparture=previous.firstDeparture??departure;
          for(let end=index+1;end<calls.length;end++){
            const {stop,arrival}=calls[end];
            if(arrival<departure||arrival>=arriveBefore)continue;
            if(stop===toId?rides<2:!allowed.has(stop))continue;
            const segments=[...previous.segments,{...boarding,end}];
            const key=stop+'|'+trip.routeId+(request.arriveBy!=null?'|'+firstDeparture:'');
            const target=stop===toId?arrivals:next;
            if(!target.has(key)||arrival<target.get(key).arrival)target.set(key,{stop,line:trip.routeId,firstDeparture,arrival,readyAt:arrival+slack,segments});
          }
        }
      }
      const sorted=[...arrivals.values()].sort((a,b)=>request.arriveBy!=null?(a.arrival-a.firstDeparture)-(b.arrival-b.firstDeparture)||b.firstDeparture-a.firstDeparture:a.arrival-b.arrival);
      // A different boarding can matter when a later connection fixes overall arrival.
      for(const option of sorted.slice(0,3))alternatives.push(option.segments.map(segment=>rawSegment(segment,leg,fromId,toId)));
      round=[...next.values()];
    }
    return alternatives;
  };
}
