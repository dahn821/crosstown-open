import {canceledTrip,findTripUpdate,indexTripUpdates,positionReportTime,trackingId} from './trip-reports.mjs';
import {approachingWithinMinute,sampleTrack} from '../Web/dist/track-position.mjs';

const feedsByStore=new WeakMap();
const dwell=25000,maxAge=90000;
const iso=ms=>new Date(ms).toISOString();
const point=({latitude,longitude})=>[latitude,longitude];
const meters=(a,b)=>Math.hypot((a[0]-b[0])*111200,(a[1]-b[1])*84200);
const shapeOf=update=>update?.tripProperties?.shapeId||update?.trip?.tripId?.split('_').at(-1);
const edge=(line,from,to)=>[line,from,to].join('|');
const asStop=stop=>({name:stop.name,coordinate:{latitude:stop.latitude,longitude:stop.longitude}});

function stopOrder(update){
  return (update?.stopTimeUpdate||[]).filter(call=>call.stopId&&call.scheduleRelationship!==1).map(call=>call.stopId);
}

function trackPoints(path){
  let distance=0;
  const points=path.map(([lat,lon],index)=>{
    if(index)distance+=meters(path[index-1],path[index]);
    return [lat,lon,distance];
  });
  return distance>0?{distance,points}:null;
}

function estimateRun(state,line,from,to,distance){
  const readings=state.runs.get(edge(line,from,to));
  if(readings?.length>=3){
    const ordered=[...readings].sort((a,b)=>a-b);
    return ordered[Math.floor(ordered.length/2)];
  }
  return Math.min(420000,Math.max(22000,Math.round((distance/9.5+12)*1000)));
}

function noteRun(state,old,observedAt){
  if(!old?.from||!old.motion||!old.transition)return;
  const run=(old.stoppedAt??(observedAt-dwell))-old.startedAt;
  if(run<12000||run>420000)return;
  const key=edge(old.line,old.from,old.target);
  const readings=state.runs.get(key)||[];
  state.runs.set(key,[...readings.slice(-6),run]);
}

// VehiclePosition supplies motion and station timestamps. TripUpdate supplies the stop order only.
function observe(store,feed,state,entry){
  const updates=indexTripUpdates(entry),patterns=new Map(),trains=new Map();
  for(const group of updates.values())for(const entity of group.values()){
    if(canceledTrip(entity))continue;
    const update=entity.tripUpdate,shape=shapeOf(update);
    if(!shape)continue;
    const ids=stopOrder(update);
    for(let i=1;i<ids.length;i++){
      const key=edge(update.trip.routeId,shape,ids[i]);
      if(!patterns.has(key))patterns.set(key,new Set());
      patterns.get(key).add(ids[i-1]);
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
    const old=state.trains.get(ref),ids=stopOrder(update),index=ids.indexOf(target);
    const stops=index>=0?ids.slice(index):[target];
    const sameStop=old?.target===target,stopped=vehicle.currentStatus===2,incoming=vehicle.currentStatus===0;
    const peers=update&&patterns.get(edge(line,shapeOf(update),target));
    const previous=ids[index-1]||(peers?.size===1?[...peers][0]:null);
    const from=sameStop?(old.from||previous):previous;
    const transition=sameStop?old.transition:Boolean(old&&old.target===from&&observedAt>old.observedAt);
    if(transition&&!sameStop)noteRun(state,old,observedAt);
    let startedAt=sameStop?old.startedAt:observedAt;
    let arrivesAt=null,motion=null;
    const stoppedAt=(sameStop?old.stoppedAt:null)??(stopped?observedAt:null);
    if(stoppedAt!=null){
      arrivesAt=stoppedAt;
    }else if(from&&from!==target){
      const path=store.subwayGeometry(line,trip.tripId,from,target,{next:stops[1],shapeId:update?.tripProperties?.shapeId,strict:true});
      const track=path&&trackPoints(path);
      if(track){
        const duration=estimateRun(state,line,from,target,track.distance);
        arrivesAt=sameStop&&old.motion?old.arrivesAt:startedAt+duration;
        if(incoming&&(!sameStop||!old.incoming)){
          arrivesAt=Math.min(arrivesAt,observedAt+15000);
          if(!transition)startedAt=arrivesAt-duration;
        }
        motion={fromStopId:from,toStopId:target,startedAt,arrivesAt,expiresAt:observedAt+maxAge,points:track.points};
      }
    }
    if(arrivesAt==null&&incoming)arrivesAt=sameStop?old.arrivesAt??observedAt+15000:observedAt+15000;
    trains.set(ref,{ref,trip,update,vehicle,line,from,target,startedAt,observedAt,arrivesAt,motion,stops,stoppedAt,incoming,transition,state});
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
  return {stopId:train.target,...asStop(stop),arrivalTime:iso(train.arrivesAt),
    departureTime:iso(Math.max(train.arrivesAt+dwell,train.observedAt+maxAge)),reportedAt:iso(train.observedAt)};
}

export function trainPosition(store,train,positionReport,now){
  if(positionReport.accuracy==='gps')return {position:positionReport};
  const nextStop=firstCall(train,store.tripIndex.stops[train.target]);
  const motion=train.motion;
  if(nextStop)nextStop.due=approachingWithinMinute(motion,train.observedAt,now);
  const sample=motion&&sampleTrack(motion,now);
  const position=sample?{...positionReport,coordinate:sample.coordinate,accuracy:'interpolated',
    status:`Estimated toward ${positionReport.stopName}`}:positionReport;
  return {position,nextStop,motion,bearing:sample?.bearing};
}

export function trainStopTimes(store,train,lastIndex=train.stops.length-1){
  const locations=store.tripIndex.stops;
  const first=firstCall(train,locations[train.target]);
  if(!first)return [];
  let departure=Math.max(train.arrivesAt+dwell,train.observedAt);
  const times=[first];
  for(let i=1;i<=lastIndex;i++){
    const prior=train.stops[i-1],stopId=train.stops[i],a=locations[prior],b=locations[stopId];
    if(!a||!b)break;
    const arrival=departure+estimateRun(train.state,train.line,prior,stopId,meters(point(a),point(b)));
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
        if(!stop||Date.parse(call.departureTime)<now||Date.parse(call.arrivalTime)>now+5400000)continue;
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
