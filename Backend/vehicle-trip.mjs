import {busLineName,busStopID,busStopName,subwayFeeds} from './feeds.mjs';
import {busTripSegments,loadBusRoute} from './bus-trip-shapes.mjs';
import {stationStopID,subwayDirection} from './subway-stations.mjs';
import {canceledTrip,findTripUpdate,freshPrediction,indexTripUpdates,positionReportTime,trackingQuery,tripReportTime,upcomingPredictions} from './trip-reports.mjs';
import {reportedPosition,vehicleDirection} from './vehicles.mjs';
import {liveTrain,trainPosition,trainStopTimes} from './subway-live.mjs';
import {remainingTrack} from '../Web/dist/track-position.mjs';

const iso=time=>new Date(time).toISOString();
export const vehicleTripQuery=params=>trackingQuery(params,['bus',...subwayFeeds]);

function currentReport(entry,trip,now){
  let best=null;
  for(const entity of entry?.message?.entity||[]){
    const v=entity.vehicle,candidate=v?.trip;
    if(entity.isDeleted||candidate?.tripId!==trip.tripId||[3,7].includes(candidate.scheduleRelationship))continue;
    if(candidate.startDate&&trip.startDate&&candidate.startDate!==trip.startDate)continue;
    const time=positionReportTime(v,now);
    if(time==null||best?.time>=time)continue;
    best={vehicle:v,time};
  }
  return best;
}

function subwaySegments(store,trip,update,ids){
  return ids.flatMap((from,index)=>{
    const to=ids[index+1];
    const path=to&&store.subwayGeometry(trip.routeId,trip.tripId,from,to,{
      previous:ids[index-1],next:ids[index+2],shapeId:update?.tripProperties?.shapeId
    });
    return path?[path]:[];
  });
}

function subwayTrip(store,query,entity,entry,now){
  if(canceledTrip(entity))return {status:'changed'};
  const train=liveTrain(store,query.feed,query.id,now);
  if(!train)return {status:'unavailable'};
  const {line,trip,update,vehicle,observedAt}=train;
  const raw=reportedPosition(store,'subway',vehicle,observedAt);
  const {position:marker,nextStop,motion,bearing}=trainPosition(store,train,raw,now);
  const times=trainStopTimes(store,train);
  const stops=train.stops.flatMap((id,sequence)=>{
    const stop=store.tripIndex.stops?.[id];
    if(!stop)return [];
    const time=times[sequence];
    return [{id,sequence,name:stop.name,coordinate:{latitude:stop.latitude,longitude:stop.longitude},
      arrivalTime:time?.arrivalTime??null,departureTime:time?.departureTime??null}];
  });
  const current=remainingTrack(motion,now);
  const segments=[...(current?[current]:[]),...subwaySegments(store,trip,update,train.stops)];
  const direction=subwayDirection(train.target,store.subwayCatalog.metadata.get(stationStopID(train.target)));
  const routeColor=store.tripIndex.routes?.[line]?.route_color||null,reportedAt=iso(observedAt);
  const heading=vehicleDirection(vehicle,update,store.tripIndex.stops);
  const position=marker?{id:query.id,trackingId:query.id,mode:'subway',line,routeColor,...marker,nextStop,motion,positionReport:raw,
    bearing:bearing??heading.bearing,bearingSource:bearing==null?heading.bearingSource:'estimated-track',directionLabel:direction,
    reportedAtSeconds:observedAt/1000,sourceTimestamp:iso(entry.sourceTimestamp),source:'MTA subway vehicle reports'}:null;
  return {status:'live',id:query.id,mode:'subway',line,routeColor,stops,segments,direction,position,reportedAt,
    estimateSource:'vehicle-reports'};
}

export async function vehicleTrip(store,query,now=Date.now()){
  const entry=store.entries.get(query.feed);
  if(!entry||store.freshness(query.feed).stale)return {status:'unavailable'};
  const entity=findTripUpdate(indexTripUpdates(entry),query);
  if(query.feed!=='bus')return subwayTrip(store,query,entity,entry,now);
  if(!entity)return {status:'unavailable'};
  const update=entity.tripUpdate,trip=update.trip;
  const measured=tripReportTime(update,entry);
  if(!freshPrediction(measured,now))return {status:'unavailable'};
  if(canceledTrip(entity))return {status:'changed',reportedAt:iso(measured)};
  const upcoming=upcomingPredictions(update,now,4*3600000);
  if(!upcoming.length)return {status:'unavailable'};
  const positionFeed='busVehicles';
  const positionEntry=store.freshness(positionFeed).stale?null:store.entries.get(positionFeed);
  const livePosition=currentReport(positionEntry,trip,now),vehicle=livePosition?.vehicle;
  const marker=livePosition?reportedPosition(store,'bus',vehicle,livePosition.time):null;
  const gps=marker?.coordinate;
  const busRoute=await loadBusRoute(store,trip.routeId,vehicle);
  const segments=busTripSegments(busRoute,trip.directionId??vehicle?.trip?.directionId,upcoming,gps);
  const stops=upcoming.map(item=>{
    const id=busStopID(item.stopId),stop=busRoute?.stops.get(id)||store.busStops.get(id);
    return {id:item.stopId,sequence:item.index,name:stop?busStopName(stop.name):`Stop ${item.stopId}`,
      coordinate:stop?{latitude:stop.lat,longitude:stop.lon}:null,
      arrivalTime:iso(item.arrival),departureTime:iso(item.departure)};
  });
  const direction=stops.length>1&&!stops.at(-1).name.startsWith('Stop ')?'Toward '+stops.at(-1).name:null;
  const line=busLineName(trip.routeId);
  const position=marker?{id:query.id,trackingId:query.id,mode:'bus',line,routeColor:null,...marker,positionReport:marker,
    ...vehicleDirection(vehicle,null,store.tripIndex.stops),
    directionLabel:direction,
    reportedAtSeconds:Date.parse(marker.reportedAt)/1000,sourceTimestamp:iso((positionEntry||entry).sourceTimestamp),
    source:'MTA Bus Time vehicle positions'}:null;
  return {status:'live',id:query.id,mode:'bus',line,routeColor:null,stops,segments,direction,reportedAt:iso(measured),position};
}
