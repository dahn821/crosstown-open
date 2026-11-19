import {busID,subwayFeeds} from './feeds.mjs';

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
function subwayNetwork(updates,index,catalog,lines,bounds,now,segments,stations){
  const overlaps=(a,b)=>Math.max(a.longitude,b.longitude)>=bounds[0]&&Math.min(a.longitude,b.longitude)<=bounds[2]&&Math.max(a.latitude,b.latitude)>=bounds[1]&&Math.min(a.latitude,b.latitude)<=bounds[3];
  for(const update of updates.values()){
    const line=update.trip.routeId;
    if(!line||(lines.length&&!lines.includes(line))||[3,7].includes(update.trip.scheduleRelationship))continue;
    const calls=(update.stopTimeUpdate||[]).filter(call=>![1,2].includes(call.scheduleRelationship)&&index.stops?.[call.stopId]);
    for(const [i,call] of calls.entries()){
      const at=number((call.arrival||call.departure)?.time)*1000;
      if(!Number.isFinite(at)||at<now-90000||at>now+90*60000)continue;
      const from=index.stops[call.stopId],fromID=call.stopId.replace(/[NS]$/,'');
      if(overlaps(from,from)&&!stations.has(fromID))stations.set(fromID,{id:'nyct:'+fromID,complexId:catalog.resolve(fromID),name:from.name,coordinate:from});
      const next=calls[i+1],to=next&&index.stops[next.stopId];
      if(!to||!overlaps(from,to))continue;
      const pair=[fromID,next.stopId.replace(/[NS]$/,'')].sort(),key=line+'|'+pair.join('|');
      if(!segments.has(key))segments.set(key,{line,color:index.routes?.[line]?.route_color||null,points:[[from.latitude,from.longitude],[to.latitude,to.longitude]]});
    }
  }
}
export function vehicleSnapshot(store,{bounds=nyc,modes=['bus','subway'],lines=[],now=Date.now(),network=false}={}){
  const vehicles=new Map(),segments=new Map(),stations=new Map(),inside=c=>c.longitude>=bounds[0]&&c.longitude<=bounds[2]&&c.latitude>=bounds[1]&&c.latitude<=bounds[3]&&c.longitude>=nyc[0]&&c.longitude<=nyc[2]&&c.latitude>=nyc[1]&&c.latitude<=nyc[3];
  for(const [feed,entry] of store.entries){
    const mode=feed==='busVehicles'?'bus':'subway';
    if((feed!=='busVehicles'&&!subwayFeeds.includes(feed))||!modes.includes(mode)||store.freshness(feed).stale||(mode==='bus'&&!store.busKey))continue;
    const canceled=new Set((entry.message?.entity||[]).flatMap(e=>{
      const t=e.tripUpdate?.trip;return t?.tripId&&[3,7].includes(t.scheduleRelationship)?[t.tripId+'|'+(t.startDate||'')]:[];
    }));
    const updates=new Map((entry.message?.entity||[]).filter(e=>!e.isDeleted&&e.tripUpdate?.trip).map(e=>[e.tripUpdate.trip.tripId+'|'+(e.tripUpdate.trip.startDate||''),e.tripUpdate]));
    if(network&&mode==='subway')subwayNetwork(updates,store.tripIndex,store.subwayCatalog,lines,bounds,now,segments,stations);
    for(const entity of entry.message?.entity||[]){
      const v=entity.vehicle,trip=v?.trip;
      if(entity.isDeleted||!v||!trip?.routeId||[3,7].includes(trip.scheduleRelationship))continue;
      if(canceled.has(trip.tripId+'|'+(trip.startDate||''))||canceled.has(trip.tripId+'|'))continue;
      const measured=number(v.timestamp)*1000;
      if(!Number.isFinite(measured)||now-measured>90000||measured>now+30000)continue;
      const line=mode==='bus'?String(trip.routeId).replace(/^(?:MTA(?:[ _](?:NYCT|MTABC|BUS))?|MTABC|NYCT)[_ :]+/i,'').replace(/\+$/,'-SBS'):String(trip.routeId);
      if(lines.length&&!lines.some(l=>mode==='bus'?busID(l)===busID(line):l===line))continue;
      let coordinate,accuracy,status,stopName=null;
      const lat=number(v.position?.latitude),lon=number(v.position?.longitude);
      if(Number.isFinite(lat)&&Number.isFinite(lon)){
        coordinate={latitude:lat,longitude:lon};accuracy='gps';status='Reported GPS position';
      }else{
        if(mode==='bus')continue;
        const stop=store.tripIndex.stops?.[v.stopId];if(!stop)continue;
        coordinate={latitude:stop.latitude,longitude:stop.longitude};stopName=stop.name;
        // A subway stop report is an anchor, never an invented latitude/longitude between stations.
        const stopped=Object.hasOwn(v,'currentStatus')&&v.currentStatus===2;
        accuracy=stopped?'reported-stop':'next-stop';
        status=stopped?`Reported at ${stop.name}`:`Heading toward ${stop.name}`;
      }
      if(!inside(coordinate))continue;
      const id=[feed,v.vehicle?.id||trip.tripId||entity.id,trip.startDate||''].join('|');
      const matching=mode==='subway'?[...updates.values()].filter(u=>u.trip.tripId===trip.tripId&&u.trip.routeId===trip.routeId&&(!trip.startDate||!u.trip.startDate||u.trip.startDate===trip.startDate)):[];
      const update=updates.get(trip.tripId+'|'+(trip.startDate||''))||(matching.length===1?matching[0]:null);
      const direction=vehicleDirection(v,mode==='subway'?update:null,store.tripIndex.stops);
      const row={id,mode,line,coordinate,accuracy,status,stopName,...direction,reportedAt:new Date(measured).toISOString(),reportedAtSeconds:measured/1000,sourceTimestamp:new Date(entry.sourceTimestamp).toISOString(),routeColor:mode==='subway'?store.tripIndex.routes?.[line]?.route_color||null:null,source:mode==='bus'?'MTA Bus Time vehicle positions':'MTA subway vehicle reports'};
      if(!vehicles.has(id)||Date.parse(vehicles.get(id).reportedAt)<measured)vehicles.set(id,row);
    }
  }
  const center={latitude:(bounds[1]+bounds[3])/2,longitude:(bounds[0]+bounds[2])/2};
  const distance=v=>(v.coordinate.latitude-center.latitude)**2+(v.coordinate.longitude-center.longitude)**2;
  const all=[...vehicles.values()].sort((a,b)=>distance(a)-distance(b)),counts=new Map();
  const visible=all.filter(v=>{const n=counts.get(v.mode)||0;counts.set(v.mode,n+1);return n<125;});
  return {vehicles:visible,generatedAt:new Date(now).toISOString(),feedStatus:store.status(),refreshSeconds:15,maxVehicleAgeSeconds:90,truncated:visible.length<all.length,totalInView:all.length,...(network?{network:{segments:[...segments.values()],stations:[...stations.values()]}}:{}),notice:'Buses show reported GPS positions. Subway markers show reported or next stations, not exact positions between stations.'};
}
