import {busID,busLineName,lineFeeds,subwayFeeds} from './feeds.mjs';
import {busLineNetwork} from './bus-trip-shapes.mjs';
import {canceledTrip,findTripUpdate,indexTripUpdates,positionReportTime,trackingId,vehicleStopStatus} from './trip-reports.mjs';
import {liveTrain,trainPosition} from './subway-live.mjs';
import {nearbySubwayBoard,stationRadius} from './subway-stations.mjs';

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
  let board;
  if(params.has('lat')||params.has('lon')){
    const latitude=Number(params.get('lat')),longitude=Number(params.get('lon')),stop=params.get('stop');
    if(modes.length!==1||modes[0]!=='subway'||!params.has('lat')||!params.has('lon')||
      !Number.isFinite(latitude)||!Number.isFinite(longitude)||stop?.length>100)throw error('Choose a valid subway board location.');
    board={coordinate:{latitude,longitude},stop,line:lines.length===1?lines[0]:undefined};
  }
  return {bounds,modes,lines,board,network:params.get('network')==='1'&&(modes.includes('subway')||(modes.includes('bus')&&lines.length===1))};
}
function subwayNetwork(updates,store,lines,bounds,segments,stations,missing){
  const index=store.tripIndex,catalog=store.subwayCatalog;
  const overlaps=(west,south,east,north,margin=0)=>east>=bounds[0]-margin&&west<=bounds[2]+margin&&north>=bounds[1]-margin&&south<=bounds[3]+margin;
  for(const update of updates.values()){
    const {routeId:line,tripId,scheduleRelationship}=update.trip;
    if(!line||(lines.length&&!lines.includes(line))||[3,7].includes(scheduleRelationship))continue;
    const calls=(update.stopTimeUpdate||[]).filter(call=>![1,2].includes(call.scheduleRelationship)&&index.stops?.[call.stopId]);
    for(const [i,call] of calls.entries()){
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

export function reportedPosition(store,mode,vehicle,measured){
  const latitude=number(vehicle.position?.latitude),longitude=number(vehicle.position?.longitude);
  const stopId=vehicle.stopId||null,reportedAt=iso(measured);
  if(latitude>=nyc[1]&&latitude<=nyc[3]&&longitude>=nyc[0]&&longitude<=nyc[2]){
    return {accuracy:'gps',coordinate:{latitude,longitude},stopId,stopName:null,reportedAt,status:'Reported GPS position'};
  }
  if(mode==='bus')return null;
  const stop=store.tripIndex.stops?.[stopId];
  if(!stop)return null;
  const stopped=vehicle.currentStatus===vehicleStopStatus.STOPPED_AT;
  return {accuracy:stopped?'reported-stop':'next-stop',coordinate:{latitude:stop.latitude,longitude:stop.longitude},
    stopId,stopName:stop.name,reportedAt,status:stopped?`Reported at ${stop.name}`:`Heading toward ${stop.name}`};
}

export function vehicleSnapshot(store,{bounds=nyc,modes=['bus','subway'],lines=[],now=Date.now(),network=false}={}){
  const availableLines=new Set(modes.includes('subway')?Object.keys(lineFeeds):[]);
  if(modes.includes('bus')&&store.busKey&&!store.freshness('bus').stale){
    for(const entity of store.entries.get('bus')?.message?.entity||[]){
      const route=entity.tripUpdate?.trip?.routeId;
      if(route&&!canceledTrip(entity))availableLines.add(busLineName(route));
    }
  }
  const vehicles=new Map(),segments=new Map(),stations=new Map(),missing=new Set(),inside=c=>c.longitude>=bounds[0]&&c.longitude<=bounds[2]&&c.latitude>=bounds[1]&&c.latitude<=bounds[3]&&c.longitude>=nyc[0]&&c.longitude<=nyc[2]&&c.latitude>=nyc[1]&&c.latitude<=nyc[3];
  for(const [feed,entry] of store.entries){
    const mode=feed==='busVehicles'?'bus':'subway';
    if((feed!=='busVehicles'&&!subwayFeeds.includes(feed))||!modes.includes(mode)||store.freshness(feed).stale||(mode==='bus'&&!store.busKey))continue;
    const predictionFeed=mode==='bus'?'bus':feed,predictionEntry=store.entries.get(predictionFeed);
    const updates=indexTripUpdates(store.freshness(predictionFeed).stale?null:predictionEntry);
    if(network&&mode==='subway'){
      const active=[...updates.values()].flatMap(group=>[...group.values()].filter(e=>!canceledTrip(e)).map(e=>e.tripUpdate));
      subwayNetwork(active,store,lines,lines.length===1?nyc:bounds,segments,stations,missing);
    }
    const eligible=line=>!lines.length||lines.some(candidate=>mode==='bus'?busID(candidate)===busID(line):candidate===line);
    for(const entity of entry.message?.entity||[]){
      const v=entity.vehicle,trip=v?.trip;
      if(entity.isDeleted||!v||!trip?.routeId||[3,7].includes(trip.scheduleRelationship))continue;
      const line=displayLine(mode,trip.routeId);
      availableLines.add(line);
      if(!eligible(line))continue;
      const match=findTripUpdate(updates,trip,candidate=>mode==='bus'?busID(candidate.routeId)===busID(trip.routeId):candidate.routeId===trip.routeId);
      if(canceledTrip(match))continue;
      const measured=positionReportTime(v,now);
      if(measured==null)continue;
      const update=match?.tripUpdate,ref=trackingId(predictionFeed,update?.trip||trip);
      const train=mode==='subway'&&liveTrain(store,feed,ref,now);
      const positionReport=reportedPosition(store,mode,train?.vehicle||v,train?.observedAt??measured);
      if(!positionReport)continue;
      const tracked=train?trainPosition(store,train,positionReport,now):{position:positionReport.accuracy==='next-stop'?null:positionReport};
      const {position:marker,nextStop,motion,bearing}=tracked;
      if(!marker||!inside(marker.coordinate))continue;
      const id=[feed,v.vehicle?.id||trip.tripId||entity.id,trip.startDate||''].join('|');
      const direction=vehicleDirection(v,mode==='subway'?update:null,store.tripIndex.stops);
      const row={id,mode,line,trackingId:ref,...marker,nextStop,motion,positionReport,...direction,
        bearing:bearing??direction.bearing,bearingSource:bearing==null?direction.bearingSource:'estimated-track',
        reportedAtSeconds:Date.parse(marker.reportedAt)/1000,sourceTimestamp:iso(entry.sourceTimestamp),
        routeColor:mode==='subway'?store.tripIndex.routes?.[line]?.route_color||null:null,
        source:mode==='bus'?'MTA Bus Time vehicle positions':'MTA subway vehicle reports'};
      if(!vehicles.has(id)||Date.parse(vehicles.get(id).reportedAt)<measured)vehicles.set(id,row);
    }
  }
  const center={latitude:(bounds[1]+bounds[3])/2,longitude:(bounds[0]+bounds[2])/2};
  const distance=v=>(v.coordinate.latitude-center.latitude)**2+(v.coordinate.longitude-center.longitude)**2;
  const all=[...vehicles.values()].sort((a,b)=>Number(!!b.nextStop?.due)-Number(!!a.nextStop?.due)||distance(a)-distance(b)),counts=new Map();
  const visible=all.filter(v=>{const n=counts.get(v.mode)||0;counts.set(v.mode,n+1);return n<125;});
  return {vehicles:visible,availableLines:[...availableLines],generatedAt:new Date(now).toISOString(),feedStatus:store.status(),refreshSeconds:15,maxVehicleAgeSeconds:90,truncated:visible.length<all.length,totalInView:all.length,...(network&&modes.includes('subway')?{network:{segments:[...segments.values()],stations:[...stations.values()],unmatchedSegments:missing.size}}:{}),notice:'Bus markers use reported GPS. Subway movement and arrival estimates use live station observations.'};
}

export async function vehicleResponse(store,query){
  const now=query.now??Date.now(),result=vehicleSnapshot(store,{...query,now});
  if(query.board){
    const {coordinate,stop,line}=query.board;
    const {latitude,longitude}=coordinate;
    const board=latitude<nyc[1]||latitude>nyc[3]||longitude<nyc[0]||longitude>nyc[2]?
      {stations:[],departures:[]}:nearbySubwayBoard(store,coordinate,{stop,line},now);
    result.board={...board,feedStatus:result.feedStatus,generatedAt:result.generatedAt,radiusMeters:stationRadius};
  }
  if(query.network&&query.modes.length===1&&query.modes[0]==='bus'&&query.lines.length===1){
    result.network=await busLineNetwork(store,query.lines[0]);
  }
  return result;
}
