import {canceledTrip,findTripUpdate,indexTripUpdates,positionReportTime,trackingId,vehicleStopStatus} from './trip-reports.mjs';
import {approachingWithinMinute,sampleTrack} from '../Web/dist/track-position.mjs';

const feedsByStore=new WeakMap();
const tracks=new WeakMap();
const dwell=25000,maxAge=90000,approachTime=15000;
const iso=ms=>new Date(ms).toISOString();
const point=({latitude,longitude})=>[latitude,longitude];
const meters=(a,b)=>Math.hypot((a[0]-b[0])*111200,(a[1]-b[1])*84200);
const shapeOf=update=>update?.tripProperties?.shapeId||update?.trip?.tripId?.split('_').at(-1);
const edge=(line,from,to)=>[line,from,to].join('|');
const asStop=stop=>({name:stop.name,coordinate:{latitude:stop.latitude,longitude:stop.longitude}});

function stopOrder(update){
  return (update?.stopTimeUpdate||[]).filter(call=>call.stopId&&![1,2].includes(call.scheduleRelationship)).map(call=>call.stopId);
}

function trackPoints(path){
  if(tracks.has(path))return tracks.get(path);
  let distance=0;
  const points=path.map(([lat,lon],index)=>{
    if(index)distance+=meters(path[index-1],path[index]);
    return [lat,lon,distance];
  });
  const track=distance>0?{distance,points}:null;
  tracks.set(path,track);
  return track;
}

function estimateRun(state,line,from,to,distance){
  const startingEstimate=Math.min(420000,Math.max(22000,Math.round((distance/9.5+12)*1000)));
  const readings=state.runs.get(edge(line,from,to));
  if(!readings?.length)return startingEstimate;
  const ordered=[...readings].sort((a,b)=>a-b),median=ordered[Math.floor(ordered.length/2)];
  const weight=Math.min(3,readings.length);
  return Math.round((median*weight+startingEstimate*(3-weight))/3);
}

function noteRun(state,old,arrivedAt){
  if(!old.from||!old.motion||old.departedAt==null)return;
  const run=arrivedAt-old.departedAt,distance=old.motion.points.at(-1)[2];
  if(run<Math.max(12000,distance/28*1000)||run>420000)return;
  const key=edge(old.line,old.from,old.target);
  const readings=state.runs.get(key)||[];
  state.runs.set(key,[...readings.slice(-6),run]);
}

function trackMovement(store,state,{line,trip,update,from,target,stops,observedAt,incoming,sameStop,old,departedAt}){
  if(!from||from===target)return null;
  const path=store.subwayGeometry(line,trip.tripId,from,target,{next:stops[1],shapeId:update?.tripProperties?.shapeId,strict:true});
  const track=path&&trackPoints(path);
  if(!track)return null;
  const duration=estimateRun(state,line,from,target,track.distance);
  const previous=sameStop&&old.motion?.fromStopId===from?old.motion:null;
  let startedAt=previous?.startedAt??departedAt??observedAt;
  let arrivesAt=previous?.arrivesAt??(startedAt+duration);
  let startDistance=previous?.startDistance??0;
  // An estimate can bring a train near a platform. Only a stop report puts it there.
  const stopOffset=Math.min(25,track.distance*.12),end=track.distance-stopOffset;
  const justApproaching=incoming&&(!previous||!old.incoming);
  if(justApproaching||previous&&observedAt>old.observedAt&&observedAt>=arrivesAt){
    const last=previous&&sampleTrack(previous,Math.min(observedAt,previous.expiresAt));
    startedAt=observedAt;
    arrivesAt=observedAt+(incoming?approachTime:Math.max(30000,Math.min(60000,duration/3)));
    const approachDistance=end*(1-approachTime/Math.max(duration,approachTime));
    startDistance=Math.min(end,Math.max(last?.distance??0,justApproaching?approachDistance:0));
  }
  return {fromStopId:from,toStopId:target,startedAt,arrivesAt,expiresAt:observedAt+maxAge,
    points:track.points,startDistance,stopOffset};
}

// VehiclePosition supplies motion and station timestamps. TripUpdate supplies the stop order only.
function observe(store,feed,state,entry){
  const updates=indexTripUpdates(entry),patterns=new Map(),trains=new Map();
  const addPattern=(key,previous)=>{
    if(!patterns.has(key))patterns.set(key,new Set());
    patterns.get(key).add(previous);
  };
  for(const group of updates.values())for(const entity of group.values()){
    if(canceledTrip(entity))continue;
    const update=entity.tripUpdate,shape=shapeOf(update);
    if(!shape)continue;
    const ids=stopOrder(update);
    for(let i=1;i<ids.length;i++){
      addPattern(edge(update.trip.routeId,shape,ids[i]),ids[i-1]);
      if(ids[i+1])addPattern(edge(update.trip.routeId,ids[i],ids[i+1]),ids[i-1]);
    }
  }
  for(const entity of entry.message?.entity||[]){
    const vehicle=entity.vehicle,trip=vehicle?.trip,target=vehicle?.stopId,line=trip?.routeId;
    if(entity.isDeleted||!trip?.tripId||!line||!store.tripIndex.stops?.[target]||[3,7].includes(trip.scheduleRelationship))continue;
    const observedAt=positionReportTime(vehicle,entry.sourceTimestamp);
    if(observedAt==null)continue;
    const match=findTripUpdate(updates,trip,candidate=>candidate.routeId===line);
    if(canceledTrip(match))continue;
    const update=match?.tripUpdate,ref=trackingId(feed,update?.trip||trip);
    if(trains.get(ref)?.observedAt>=observedAt)continue;
    const old=state.trains.get(ref),ids=stopOrder(update);
    if(old&&observedAt<old.observedAt){trains.set(ref,old);continue;}
    const index=ids.indexOf(target);
    const stops=index>=0?ids.slice(index):[target];
    const sameStop=old?.target===target,stopped=vehicle.currentStatus===vehicleStopStatus.STOPPED_AT;
    const incoming=vehicle.currentStatus===vehicleStopStatus.INCOMING_AT;
    const advanced=old&&old.target!==target&&old.line===line&&observedAt>old.observedAt;
    const observedPrevious=advanced&&old.stops[1]===target?old.target:null;
    const peers=patterns.get(edge(line,shapeOf(update),target));
    const routing=stops[1]&&patterns.get(edge(line,target,stops[1]));
    const previous=ids[index-1]||observedPrevious||(peers?.size===1?[...peers][0]:null)||
      (routing?.size===1?[...routing][0]:null);
    const from=sameStop?(old.from||previous):previous;
    const departedAt=sameStop?old.departedAt:advanced&&old.target===from&&!stopped?observedAt:null;
    const stoppedAt=stopped?((sameStop?old.stoppedAt:null)??observedAt):null;
    if(stopped&&sameStop&&old.stoppedAt==null)noteRun(state,old,observedAt);
    const motion=stopped?null:trackMovement(store,state,{line,trip,update,from,target,stops,observedAt,incoming,sameStop,old,departedAt});
    const arrivesAt=stoppedAt??motion?.arrivesAt??(incoming?observedAt+approachTime:null);
    trains.set(ref,{ref,trip,update,vehicle,line,from,target,departedAt,observedAt,arrivesAt,motion,stops,stoppedAt,incoming,state});
  }
  state.trains=trains;
  state.message=entry.message;
}

function trainReports(store,feed){
  const entry=store.entries.get(feed);
  if(!entry?.message||!Number.isFinite(entry.sourceTimestamp)||!feed.startsWith('gtfs'))return new Map();
  if(!feedsByStore.has(store))feedsByStore.set(store,new Map());
  const feeds=feedsByStore.get(store);
  if(!feeds.has(feed))feeds.set(feed,{message:null,trains:new Map(),runs:new Map()});
  const state=feeds.get(feed);
  if(state.message!==entry.message)observe(store,feed,state,entry);
  return state.trains;
}

export function liveTrain(store,feed,id,now){
  const train=trainReports(store,feed).get(id);
  return train&&now>=train.observedAt-30000&&now<=train.observedAt+maxAge?train:null;
}

function firstCall(train,stop){
  if(train.arrivesAt==null)return null;
  const departure=train.stoppedAt==null?train.arrivesAt+dwell:Math.max(train.arrivesAt+dwell,train.observedAt+15000);
  return {stopId:train.target,...asStop(stop),arrivalTime:iso(train.arrivesAt),
    departureTime:iso(departure),reportedAt:iso(train.observedAt)};
}

export function trainPosition(store,train,positionReport,now){
  if(positionReport.accuracy==='gps')return {position:positionReport};
  const nextStop=firstCall(train,store.tripIndex.stops[train.target]);
  const motion=train.motion;
  if(nextStop)nextStop.due=approachingWithinMinute(motion,train.observedAt,now);
  const sample=motion&&sampleTrack(motion,now);
  const position=sample?{...positionReport,coordinate:sample.coordinate,accuracy:'interpolated',
    status:`Estimated toward ${positionReport.stopName}`}:positionReport.accuracy==='reported-stop'?positionReport:null;
  return {position,nextStop,motion,bearing:sample?.bearing};
}

export function trainStopTimes(store,train,lastIndex=train.stops.length-1){
  const locations=store.tripIndex.stops;
  const first=firstCall(train,locations[train.target]);
  if(!first)return [];
  let departure=Date.parse(first.departureTime);
  const times=[first];
  for(let i=1;i<=lastIndex;i++){
    const prior=train.stops[i-1],stopId=train.stops[i],a=locations[prior],b=locations[stopId];
    if(!a||!b)break;
    const path=store.subwayGeometry(train.line,train.trip.tripId,prior,stopId,
      {previous:train.stops[i-2],next:train.stops[i+1],shapeId:train.update?.tripProperties?.shapeId,strict:true});
    const distance=path?trackPoints(path)?.distance:meters(point(a),point(b));
    if(!distance)break;
    const arrival=departure+estimateRun(train.state,train.line,prior,stopId,distance);
    departure=arrival+dwell;
    times.push({stopId,...asStop(b),arrivalTime:iso(arrival),departureTime:iso(departure),reportedAt:first.reportedAt});
  }
  return times;
}

export function liveSubwayDepartures(store,platforms,now,line){
  const platformsById=new Map(platforms.map(stop=>[stop.gtfsId.split(':').at(-1),stop]));
  const rows=[];
  for(const [feed] of store.entries){
    if(!feed.startsWith('gtfs')||store.freshness(feed).stale)continue;
    for(const train of trainReports(store,feed).values()){
      if(now<train.observedAt-30000||now>train.observedAt+maxAge||(line&&line!==train.line))continue;
      const last=train.stops.findLastIndex(id=>platformsById.has(id));
      if(last<0)continue;
      for(const [index,call] of trainStopTimes(store,train,last).entries()){
        const stop=platformsById.get(call.stopId);
        const arrival=Date.parse(call.arrivalTime);
        const atPlatform=index===0&&train.stoppedAt!=null&&now-train.observedAt<60000;
        if(!stop||!atPlatform&&(Date.parse(call.departureTime)<now||arrival<=now||arrival>now+5400000))continue;
        rows.push({id:[train.ref,call.stopId,index].join('|'),mode:'subway',line:train.line,trackingId:train.ref,
          stationId:stop.stationId,stop:{id:stop.gtfsId,name:stop.name,neighborhood:'New York City',coordinate:call.coordinate,selectable:true},
          metersAway:stop.distance,arrivalTime:call.arrivalTime,departureTime:call.departureTime,predictionReportedAt:call.reportedAt,
          routeColor:store.tripIndex.routes?.[train.line]?.route_color||null,estimateSource:'vehicle-reports',isNextStop:index===0});
      }
    }
  }
  const counts=new Map();
  return rows.sort((a,b)=>a.arrivalTime.localeCompare(b.arrivalTime)||a.metersAway-b.metersAway).filter(row=>{
    const key=row.stop.id+'|'+row.line,count=counts.get(key)||0;
    counts.set(key,count+1);
    return count<3;
  });
}
