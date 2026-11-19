import {busLineName,busStopID,busStopName,subwayFeeds} from './feeds.mjs';
import {busTripSegments,loadBusRoute} from './bus-trip-shapes.mjs';
import {stationStopID,subwayDirection} from './subway-stations.mjs';
import {canceledTrip,findTripUpdate,freshPrediction,indexTripUpdates,positionReportTime,trackingQuery,tripReportTime,upcomingPredictions} from './trip-reports.mjs';
import {arrivalAnchor,predictedPosition,reportedPosition,vehicleDirection} from './vehicles.mjs';

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

function subwaySegments(store,trip,update,upcoming,lastStopId){
  const ids=[...(lastStopId?[lastStopId]:[]),...upcoming.map(item=>item.stopId)];
  return ids.flatMap((from,index)=>{
    const to=ids[index+1];
    const path=to&&store.subwayGeometry(trip.routeId,trip.tripId,from,to,{
      previous:ids[index-1],next:ids[index+2],shapeId:update.tripProperties?.shapeId
    });
    return path?[path]:[];
  });
}

export async function vehicleTrip(store,query,now=Date.now()){
  const mode=query.feed==='bus'?'bus':'subway';
  const entry=store.entries.get(query.feed);
  if(!entry||store.freshness(query.feed).stale)return {status:'unavailable'};
  const entity=findTripUpdate(indexTripUpdates(entry),query);
  if(!entity)return {status:'unavailable'};
  const update=entity.tripUpdate,trip=update.trip;
  const measured=tripReportTime(update,entry);
  if(!freshPrediction(measured,now))return {status:'unavailable'};
  if(canceledTrip(entity))return {status:'changed',reportedAt:iso(measured)};
  const upcoming=upcomingPredictions(update,now,4*3600000);
  if(!upcoming.length)return {status:'unavailable'};
  const positionFeed=mode==='bus'?'busVehicles':query.feed;
  const positionEntry=store.freshness(positionFeed).stale?null:store.entries.get(positionFeed);
  const livePosition=currentReport(positionEntry,trip,now),vehicle=livePosition?.vehicle;
  const positionReport=livePosition?reportedPosition(store,mode,vehicle,livePosition.time):null;
  const nextStop=mode==='subway'?arrivalAnchor(store,entity,entry,now):null;
  const estimate=predictedPosition(positionReport,nextStop),marker=estimate||positionReport;
  const gps=positionReport?.accuracy==='gps'?positionReport.coordinate:null;
  const busRoute=mode==='bus'?await loadBusRoute(store,trip.routeId,vehicle):null;
  const first=upcoming[0];
  const currentIndex=update.stopTimeUpdate.findIndex(call=>call.stopId===vehicle?.stopId);
  const lastStopId=marker?.accuracy==='reported-stop'&&currentIndex>=0&&currentIndex<first.index?vehicle.stopId:null;
  const segments=mode==='bus'?busTripSegments(busRoute,trip.directionId??vehicle?.trip?.directionId,upcoming,gps):
    subwaySegments(store,trip,update,upcoming,lastStopId);
  const stops=upcoming.map(item=>{
    let name,coordinate=null;
    if(mode==='bus'){
      const id=busStopID(item.stopId),stop=busRoute?.stops.get(id)||store.busStops.get(id);
      if(stop){name=busStopName(stop.name);coordinate={latitude:stop.lat,longitude:stop.lon};}
    }else{
      const stop=store.tripIndex.stops?.[item.stopId];
      if(stop){name=stop.name;coordinate={latitude:stop.latitude,longitude:stop.longitude};}
    }
    return {id:item.stopId,sequence:item.index,name:name||`Stop ${item.stopId}`,coordinate,
      arrivalTime:iso(item.arrival),departureTime:iso(item.departure)};
  });
  const direction=mode==='subway'?subwayDirection(first.stopId,store.subwayCatalog.metadata.get(stationStopID(first.stopId))):
    stops.length>1&&!stops.at(-1).name.startsWith('Stop ')?'Toward '+stops.at(-1).name:null;
  const line=mode==='bus'?busLineName(trip.routeId):trip.routeId;
  const routeColor=mode==='subway'?store.tripIndex.routes?.[line]?.route_color||null:null;
  const position=marker?{id:query.id,trackingId:query.id,mode,line,routeColor,...marker,nextStop,positionReport,
    ...vehicleDirection(estimate?{stopId:nextStop.stopId}:vehicle,mode==='subway'?update:null,store.tripIndex.stops),
    directionLabel:direction,
    reportedAtSeconds:Date.parse(marker.reportedAt)/1000,sourceTimestamp:iso((positionEntry||entry).sourceTimestamp),
    source:mode==='bus'?'MTA Bus Time vehicle positions':estimate?'MTA subway arrival predictions':'MTA subway vehicle reports'}:null;
  return {status:'live',id:query.id,mode,line,routeColor,stops,segments,direction,reportedAt:iso(measured),position};
}
