import {busID,busLineName,subwayFeeds} from './feeds.mjs';
import {canceledTrip,duePrediction,findTripUpdate,freshPrediction,indexTripUpdates,positionReportTime,trackingId,tripReportTime,upcomingPredictions} from './trip-reports.mjs';

const nyc=[-74.27,40.48,-73.67,40.94];
const number=value=>value==null?NaN:Number(value.toString());
const error=message=>Object.assign(Error(message),{status:400});
const heading=(a,b)=>{
  const r=Math.PI/180,delta=(b.longitude-a.longitude)*r;
  const y=Math.sin(delta)*Math.cos(b.latitude*r),x=Math.cos(a.latitude*r)*Math.sin(b.latitude*r)-Math.sin(a.latitude*r)*Math.cos(b.latitude*r)*Math.cos(delta);
  return Math.abs(x)+Math.abs(y)<1e-12?null:(Math.atan2(y,x)/r+360)%360;
};
export function vehicleDirection(vehicle,updates,stops={}){
  const bearing=vehicle.position&&Object.hasOwn(vehicle.position,'bearing')?number(vehicle.position.bearing):NaN;
  if(Number.isFinite(bearing)&&bearing>=0&&bearing<360)return {bearing,bearingSource:'gps',directionLabel:'MTA reported heading'};
  const calls=updates?.stopTimeUpdate||[],index=calls.findIndex(c=>c.stopId===vehicle.stopId);
  const anchor=stops[vehicle.stopId];if(index<0||!anchor)return {bearing:null,bearingSource:null,directionLabel:null};
  const next=calls.slice(index+1).map(c=>stops[c.stopId]).find(s=>s&&(s.latitude!==anchor.latitude||s.longitude!==anchor.longitude));
  const previous=calls.slice(0,index).reverse().map(c=>stops[c.stopId]).find(s=>s&&(s.latitude!==anchor.latitude||s.longitude!==anchor.longitude));
  const value=next?heading(anchor,next):previous?heading(previous,anchor):null;
  return {bearing:value,bearingSource:value==null?null:'stop-sequence',directionLabel:value==null?null:next?`Toward ${next.name} · estimated from stop sequence`:`Toward ${anchor.name} · estimated from stop sequence`};
}
export function vehicleQuery(params){
  const bounds=params.has('bbox')?params.get('bbox').split(',').map(Number):nyc;
  if(bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]||bounds[0]< -180||bounds[2]>180||bounds[1]< -85||bounds[3]>85)throw error('Choose a valid map area.');
  const modes=params.has('modes')?params.get('modes').split(','):['bus','subway'];
  if(!modes.length||modes.some(m=>!['bus','subway'].includes(m)))throw error('Choose bus or subway map layers.');
  const lines=(params.get('lines')||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(lines.length>40||lines.some(l=>l.length>30||!/^[a-z0-9+ -]+$/i.test(l)))throw error('Choose valid transit lines.');
  return {bounds,modes,lines,network:params.get('network')==='1'&&modes.includes('subway')};
}
function subwayNetwork(updates,store,lines,bounds,now,segments,stations,missing){
  const index=store.tripIndex,catalog=store.subwayCatalog;
  const overlaps=(west,south,east,north,margin=0)=>east>=bounds[0]-margin&&west<=bounds[2]+margin&&north>=bounds[1]-margin&&south<=bounds[3]+margin;
  for(const update of updates.values()){
    const {routeId:line,tripId,scheduleRelationship}=update.trip;
    if(!line||(lines.length&&!lines.includes(line))||[3,7].includes(scheduleRelationship))continue;
    const calls=(update.stopTimeUpdate||[]).filter(call=>![1,2].includes(call.scheduleRelationship)&&index.stops?.[call.stopId]);
    for(const [i,call] of calls.entries()){
      const at=number((call.arrival||call.departure)?.time)*1000;
      if(!Number.isFinite(at)||at<now-90000||at>now+90*60000)continue;
      const from=index.stops[call.stopId],fromID=call.stopId.replace(/[NS]$/,'');
      if(overlaps(from.longitude,from.latitude,from.longitude,from.latitude)&&!stations.has(fromID))stations.set(fromID,{id:'nyct:'+fromID,complexId:catalog.resolve(fromID),name:from.name,coordinate:from});
      const next=calls[i+1],to=next&&index.stops[next.stopId];
      if(!to||!overlaps(Math.min(from.longitude,to.longitude),Math.min(from.latitude,to.latitude),Math.max(from.longitude,to.longitude),Math.max(from.latitude,to.latitude),.008))continue;
      const pair=[fromID,next.stopId.replace(/[NS]$/,'')].sort(),key=line+'|'+pair.join('|');
      if(segments.has(key))continue;
      const points=store.subwayGeometry(line,tripId,call.stopId,next.stopId,{
        previous:calls[i-1]?.stopId,next:calls[i+2]?.stopId,shapeId:update.tripProperties?.shapeId
      });
      if(!points){missing.add(key);continue;}
      missing.delete(key);
      const latitudes=points.map(point=>point[0]),longitudes=points.map(point=>point[1]);
      if(overlaps(Math.min(...longitudes),Math.min(...latitudes),Math.max(...longitudes),Math.max(...latitudes))){
        segments.set(key,{line,color:index.routes?.[line]?.route_color||null,points});
      }
    }
  }
}
const iso=time=>new Date(time).toISOString();
const displayLine=(mode,route)=>mode==='bus'?busLineName(route):String(route);

export function arrivalAnchor(store,entity,entry,now){
  if(!entity||canceledTrip(entity))return null;
  const update=entity.tripUpdate,reportedAt=tripReportTime(update,entry);
  if(!freshPrediction(reportedAt,now))return null;
  const first=upcomingPredictions(update,now)[0],stop=first&&store.tripIndex.stops?.[first.stopId];
  return stop?{stopId:first.stopId,name:stop.name,coordinate:{latitude:stop.latitude,longitude:stop.longitude},
    arrivalTime:iso(first.arrival),departureTime:iso(first.departure),reportedAt:iso(reportedAt),due:duePrediction(first,now)}:null;
}

export function reportedPosition(store,mode,vehicle,measured){
  const latitude=number(vehicle.position?.latitude),longitude=number(vehicle.position?.longitude);
  const stopId=vehicle.stopId||null,reportedAt=iso(measured);
  if(latitude>=nyc[1]&&latitude<=nyc[3]&&longitude>=nyc[0]&&longitude<=nyc[2]){
    return {accuracy:'gps',coordinate:{latitude,longitude},stopId,stopName:null,reportedAt,status:'Reported GPS position'};
  }
  if(mode==='bus')return null;
  const stop=store.tripIndex.stops?.[stopId];
  if(!stop)return null;
  const stopped=Object.hasOwn(vehicle,'currentStatus')&&vehicle.currentStatus===2;
  return {accuracy:stopped?'reported-stop':'next-stop',coordinate:{latitude:stop.latitude,longitude:stop.longitude},
    stopId,stopName:stop.name,reportedAt,status:stopped?`Reported at ${stop.name}`:`Heading toward ${stop.name}`};
}

export function predictedPosition(position,nextStop){
  if(!nextStop?.due||position?.accuracy==='gps'||(position?.accuracy==='reported-stop'&&position.stopId===nextStop.stopId))return null;
  return {accuracy:'prediction-stop',coordinate:nextStop.coordinate,stopName:nextStop.name,
    reportedAt:nextStop.reportedAt,status:`Due at ${nextStop.name}`};
}

export function vehicleSnapshot(store,{bounds=nyc,modes=['bus','subway'],lines=[],now=Date.now(),network=false}={}){
  const vehicles=new Map(),segments=new Map(),stations=new Map(),missing=new Set(),inside=c=>c.longitude>=bounds[0]&&c.longitude<=bounds[2]&&c.latitude>=bounds[1]&&c.latitude<=bounds[3]&&c.longitude>=nyc[0]&&c.longitude<=nyc[2]&&c.latitude>=nyc[1]&&c.latitude<=nyc[3];
  for(const [feed,entry] of store.entries){
    const mode=feed==='busVehicles'?'bus':'subway';
    if((feed!=='busVehicles'&&!subwayFeeds.includes(feed))||!modes.includes(mode)||store.freshness(feed).stale||(mode==='bus'&&!store.busKey))continue;
    const predictionFeed=mode==='bus'?'bus':feed,predictionEntry=store.entries.get(predictionFeed);
    const updates=indexTripUpdates(store.freshness(predictionFeed).stale?null:predictionEntry),represented=new Set();
    if(network&&mode==='subway'){
      const active=[...updates.values()].flatMap(group=>[...group.values()].filter(e=>!canceledTrip(e)).map(e=>e.tripUpdate));
      subwayNetwork(active,store,lines,bounds,now,segments,stations,missing);
    }
    const eligible=line=>!lines.length||lines.some(candidate=>mode==='bus'?busID(candidate)===busID(line):candidate===line);
    for(const entity of entry.message?.entity||[]){
      const v=entity.vehicle,trip=v?.trip;
      if(entity.isDeleted||!v||!trip?.routeId||[3,7].includes(trip.scheduleRelationship))continue;
      const match=findTripUpdate(updates,trip,candidate=>mode==='bus'?busID(candidate.routeId)===busID(trip.routeId):candidate.routeId===trip.routeId);
      if(canceledTrip(match))continue;
      const measured=positionReportTime(v,now);
      if(measured==null)continue;
      const line=displayLine(mode,trip.routeId);
      if(!eligible(line))continue;
      const update=match?.tripUpdate,ref=trackingId(predictionFeed,update?.trip||trip);
      const nextStop=mode==='subway'?arrivalAnchor(store,match,predictionEntry,now):null;
      const positionReport=reportedPosition(store,mode,v,measured);
      const estimate=predictedPosition(positionReport,nextStop),marker=estimate||positionReport;
      if(!marker)continue;
      if(ref)represented.add(ref);
      if(!inside(marker.coordinate))continue;
      const id=[feed,v.vehicle?.id||trip.tripId||entity.id,trip.startDate||''].join('|');
      const direction=vehicleDirection(estimate?{stopId:nextStop.stopId}:v,mode==='subway'?update:null,store.tripIndex.stops);
      const row={id,mode,line,trackingId:ref,...marker,nextStop,positionReport,...direction,
        reportedAtSeconds:Date.parse(marker.reportedAt)/1000,sourceTimestamp:iso(entry.sourceTimestamp),
        routeColor:mode==='subway'?store.tripIndex.routes?.[line]?.route_color||null:null,
        source:mode==='bus'?'MTA Bus Time vehicle positions':estimate?'MTA subway arrival predictions':'MTA subway vehicle reports'};
      if(!vehicles.has(id)||Date.parse(vehicles.get(id).reportedAt)<measured)vehicles.set(id,row);
    }
    if(mode==='subway')for(const group of updates.values())for(const entity of group.values()){
      const update=entity.tripUpdate,trip=update.trip,line=displayLine(mode,trip.routeId),ref=trackingId(feed,trip);
      if(!trip.routeId||represented.has(ref)||!eligible(line))continue;
      const nextStop=arrivalAnchor(store,entity,predictionEntry,now);
      if(!nextStop?.due||!inside(nextStop.coordinate))continue;
      const reportedAt=nextStop.reportedAt;
      vehicles.set(ref,{id:ref,mode,line,trackingId:ref,coordinate:nextStop.coordinate,accuracy:'prediction-stop',
        status:`Due at ${nextStop.name}`,stopName:nextStop.name,nextStop,
        ...vehicleDirection({stopId:nextStop.stopId},update,store.tripIndex.stops),
        reportedAt,reportedAtSeconds:Date.parse(reportedAt)/1000,sourceTimestamp:iso(entry.sourceTimestamp),
        routeColor:store.tripIndex.routes?.[line]?.route_color||null,source:'MTA subway arrival predictions'});
    }
  }
  const center={latitude:(bounds[1]+bounds[3])/2,longitude:(bounds[0]+bounds[2])/2};
  const distance=v=>(v.coordinate.latitude-center.latitude)**2+(v.coordinate.longitude-center.longitude)**2;
  const all=[...vehicles.values()].sort((a,b)=>Number(!!b.nextStop?.due)-Number(!!a.nextStop?.due)||distance(a)-distance(b)),counts=new Map();
  const visible=all.filter(v=>{const n=counts.get(v.mode)||0;counts.set(v.mode,n+1);return n<125;});
  return {vehicles:visible,generatedAt:new Date(now).toISOString(),feedStatus:store.status(),refreshSeconds:15,maxVehicleAgeSeconds:90,truncated:visible.length<all.length,totalInView:all.length,...(network?{network:{segments:[...segments.values()],stations:[...stations.values()],unmatchedSegments:missing.size}}:{}),notice:'Bus markers show reported GPS positions. Subway markers use MTA station reports and upcoming arrival estimates.'};
}
