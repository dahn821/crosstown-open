import fs from 'node:fs';
import crypto from 'node:crypto';
import {busStopID,subwayFeeds} from './feeds.mjs';
import {walkingPaces,walkingSpeed} from './walking.mjs';
import {subwayOptions,predictionSnapshot} from './subway-options.mjs';
import {classicCyclingSpeed,freshBikeStation,lowAssistPickup,lowAssistTrip,rentalDuration} from './citi-bike.mjs';
import {createSubwayTransferSearch} from './subway-transfers.mjs';
import {subwayJourneyPoints} from './subway-shapes.mjs';
export const OTP_URL=process.env.OTP_URL||'http://127.0.0.1:9090/otp/gtfs/v1';
export async function graphql(query,variables={},fetcher=fetch){
  const response=await fetcher(OTP_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('Routing engine returned '+response.status);
  const result=await response.json();if(result.errors?.length)throw Error(result.errors.map(e=>e.message).join('; '));return result.data;
}
const read=name=>{try{return JSON.parse(fs.readFileSync(new URL('./data/'+name,import.meta.url),'utf8'));}catch{return {};}};
const stationStructures=read('station-structures.json');
const structures=new Map((Array.isArray(stationStructures)?stationStructures:[]).map(s=>[s.gtfs_stop_id,s.structure]));
let tripIndex=read('trip-index.json');
export function configureRoutingData({stations,index}){
  if(stations){structures.clear();for(const station of stations)structures.set(station.gtfs_stop_id,station.structure);}
  if(index)tripIndex=index;
}
export const defaults=()=>({priority:'fastest',modes:['walk','bike','subway','bus'],maxFareCents:1500,maxWalkingMinutes:30,maxBikingMinutes:45,maxTransfers:2,citiBikeMember:true,bikeSource:'citiBike',walkingPace:'brisk',timeWeight:70,costWeight:25,outsideWeight:25,undergroundWeight:0,requireLiveTransit:true});
const placeId=id=>String(id||'').split(':').at(-1);
const coordinate=p=>({latitude:p.lat,longitude:p.lon});
const label=p=>({id:p.stop?.gtfsId||p.vehicleRentalStation?.stationId||`coord:${p.lat},${p.lon}`,name:p.name,neighborhood:p.stop?'Subway station':'New York City',coordinate:coordinate(p),selectable:true});
function handoffLabel(place,adjacent){
  const placeholder=name=>!name||name==='START'||name==='END';
  return label(placeholder(place.name)&&!placeholder(adjacent?.name)?{...place,name:adjacent.name}:place);
}
const toInput=p=>({label:p.name,location:{coordinate:p.coordinate}});
const stopInput=id=>({location:{stopLocation:{stopLocationId:'nyct:'+id}}});
const distance=(a,b)=>{const r=Math.PI/180,h=Math.sin((b.latitude-a.latitude)*r/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((b.longitude-a.longitude)*r/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));};
const timestamp=t=>Date.parse(t?.estimated?.time||t?.scheduledTime||'');
export function decodePolyline(s){let i=0,lat=0,lon=0,coords=[];while(i<s.length){const number=()=>{let shift=0,result=0,b;do{b=s.charCodeAt(i++)-63;result|=(b&31)<<shift;shift+=5;if(shift>30||i>s.length+1)throw Error('Invalid route geometry');}while(b>=32);return result&1?~(result>>1):result>>1;};lat+=number();lon+=number();coords.push({latitude:lat/1e5,longitude:lon/1e5});}return coords;}
const fields=`start end duration legs { id mode rentedBike walkingBike duration distance headsign
 start {scheduledTime estimated {time}} end {scheduledTime estimated {time}}
 from {name lat lon stop {gtfsId parentStation {gtfsId}} vehicleRentalStation {stationId}}
 to {name lat lon stop {gtfsId parentStation {gtfsId}} vehicleRentalStation {stationId}}
 route {shortName gtfsId color} trip {gtfsId} legGeometry {points}
 stopCalls {stopLocation {...on Stop {gtfsId name lat lon}}}
 steps {distance relativeDirection absoluteDirection streetName walkingBike lat lon}
}`;
const query=`query Routes($origin:PlanLabeledLocationInput!,$destination:PlanLabeledLocationInput!,$modes:PlanModesInput,$preferences:PlanPreferencesInput,$date:PlanDateTimeInput){
 planConnection(origin:$origin,destination:$destination,dateTime:$date,first:10,searchWindow:"PT90M",modes:$modes,preferences:$preferences){edges{node{${fields}}}}}`;

export function validateRequest(request){
  if(!request||typeof request!=='object'||Array.isArray(request))throw Object.assign(Error('Invalid route request.'),{status:400});
  for(const p of [request.origin,request.destination])if(!p?.coordinate||!Number.isFinite(p.coordinate.latitude)||!Number.isFinite(p.coordinate.longitude)||p.coordinate.latitude<40.48||p.coordinate.latitude>40.94||p.coordinate.longitude< -74.27||p.coordinate.longitude> -73.67)throw Object.assign(Error('Choose a start and destination in New York City.'),{status:400});
  if(distance(request.origin.coordinate,request.destination.coordinate)<10)throw Object.assign(Error('Choose two different places.'),{status:400});
  const p={...defaults(),...request.preferences};
  if(!Object.hasOwn(walkingPaces,p.walkingPace))throw Object.assign(Error('Choose a valid walking pace.'),{status:400});
  for(const pace of [p.classicBikePaceMph,p.lowAssistBikePaceMph])if(pace!=null&&(!Number.isFinite(pace)||pace<4||pace>18))throw Object.assign(Error('Bike paces must be between 4 and 18 mph.'),{status:400});
  if(!['fastest','cost','aboveGround','sheltered','custom'].includes(p.priority)||!['citiBike','ownBike'].includes(p.bikeSource)||!Array.isArray(p.modes)||!p.modes.length||p.modes.some(m=>!['walk','bike','subway','bus'].includes(m)))throw Object.assign(Error('Choose at least one travel mode and valid preferences.'),{status:400});
  for(const key of ['maxFareCents','maxWalkingMinutes','maxBikingMinutes','maxTransfers','timeWeight','costWeight','outsideWeight','undergroundWeight'])if(!Number.isFinite(p[key])||p[key]<0)throw Object.assign(Error('Check your budget and travel limits.'),{status:400});
  if(p.maxWalkingMinutes>240||p.maxBikingMinutes>240||p.maxTransfers>5||p.maxFareCents>50000)throw Object.assign(Error('Travel limits are outside the supported range.'),{status:400});
  if(request.departureTime!=null&&request.arrivalTime!=null)throw Object.assign(Error('Choose either Depart at or Arrive by.'),{status:400});
  const now=Date.now(),arriveBy=request.arrivalTime!=null?Date.parse(request.arrivalTime):null;
  const depart=request.departureTime!=null?Date.parse(request.departureTime):now,selected=arriveBy??depart;
  if(!Number.isFinite(selected)||selected<now-60000||selected>now+86400000*14)throw Object.assign(Error('Choose a departure or arrival within the next 14 days.'),{status:400});
  return {...request,preferences:p,depart,arriveBy};
}

async function search(origin,destination,modes,p,instant,arriveBy=false,{cyclingSpeed=classicCyclingSpeed}={}){
  const preferences={street:{walk:{speed:walkingSpeed(p),reluctance:2},bicycle:{speed:cyclingSpeed,reluctance:1,optimization:{type:'SHORTEST_DURATION'},rental:{allowedNetworks:['citibike']}}},transit:{board:{slack:'PT45S'},transfer:{slack:'PT90S',maximumTransfers:p.maxTransfers}}};
  const result=await graphql(query,{origin,destination,modes,preferences,date:{[arriveBy?'latestArrival':'earliestDeparture']:new Date(instant).toISOString()}});
  return result.planConnection.edges.map(e=>e.node);
}
function isUnderground(stop){const structure=structures.get(placeId(stop).replace(/[NS]$/,''));return structure==null?1:structure==='Subway'?1:0;}
function undergroundFraction(leg){const stops=(leg.stopCalls||[]).map(c=>c.stopLocation?.gtfsId).filter(Boolean);if(stops.length<2)return (isUnderground(leg.from.stop?.gtfsId)+isUnderground(leg.to.stop?.gtfsId))/2;let sum=0;for(let i=1;i<stops.length;i++)sum+=(isUnderground(stops[i-1])+isUnderground(stops[i]))/2;return sum/(stops.length-1);}

function routeStopDetails(leg,mode,live,store){
  const idFor=mode==='bus'?busStopID:placeId;
  const names=new Map((leg.stopCalls||[]).flatMap(({stopLocation:stop})=>stop?.gtfsId&&stop.name?[[idFor(stop.gtfsId),stop.name]]:[]));
  const ids=(live?.stopIds??leg.stopCalls?.map(call=>call.stopLocation?.gtfsId))?.map(idFor);
  if(!ids||ids.length<2||ids.some(id=>!id)||ids[0]!==idFor(leg.from.stop?.gtfsId)||ids.at(-1)!==idFor(leg.to.stop?.gtfsId))return {};
  const intermediateStops=ids.slice(1,-1).map(id=>({id,name:names.get(id)||
    (mode==='subway'?store.tripIndex?.stops?.[id]?.name:store.busStops?.get(id)?.name)}));
  return {stopCount:ids.length-1,...(intermediateStops.every(stop=>stop.name)?{intermediateStops}:{})};
}

// Work backwards from a real arrival deadline, then verify every connection forwards.
// Subtract boarding/transfer slack before access legs so we never suggest a missed train.
function latestStart(raw,request,store){
  const connections=new Map();let clock=request.arriveBy,remaining=raw.legs.filter(l=>['SUBWAY','BUS'].includes(l.mode)).length;
  for(let i=raw.legs.length-1;i>=0;i--){const l=raw.legs[i];
    if(['SUBWAY','BUS'].includes(l.mode)){
      const live=store.connection({line:l.route?.shortName,tripId:l.pinnedTripId,fromStop:placeId(l.from.stop?.gtfsId),toStop:placeId(l.to.stop?.gtfsId),readyAt:request.depart,latestArrival:clock,earliestArrival:clock-90*60000,kind:l.mode==='BUS'?'bus':'subway'});
      if(l.pinnedTripId&&!live)return null;
      const departure=live?.departure??timestamp(l.start),arrival=live?.arrival??timestamp(l.end);
      if((!live&&request.preferences.requireLiveTransit)||!Number.isFinite(departure)||!Number.isFinite(arrival)||arrival>clock||arrival<departure)return null;
      connections.set(i,live);remaining--;clock=departure-(remaining?90000:45000)-(l.extraAccessMinutes||0)*60000;
    }else clock-=(l.rentedBike&&request.preferences.bikeSource==='citiBike'?rentalDuration(l,request.preferences):l.duration)*1000;
  }
  return clock>=request.depart?{start:clock,connections}:null;
}
export function normalize(raw,request,store){
  const backwards=request.arriveBy!=null?latestStart(raw,request,store):null;if(request.arriveBy!=null&&!backwards)return null;
  const start=backwards?.start??request.depart;
  const p=request.preferences,stations=raw.legs.some(l=>l.rentedBike)?new Map(store.bikeStations().map(s=>[s.id,s])):null,legs=[];let clock=start,boardings=0,fare=0,allLive=true,transitRides=0;
  for(let i=0;i<raw.legs.length;i++){
    const l=raw.legs[i],mode=l.mode==='BICYCLE'?'bike':l.mode==='SUBWAY'?'subway':l.mode==='BUS'?'bus':l.mode==='WALK'?'walk':null;
    if(!mode||!p.modes.includes(mode)||(mode==='bus'&&p.bikeSource==='ownBike'))return null;
    const line=l.route?.shortName,lowAssist=l.bikeRideType==='lowAssist';
    const rideSeconds=mode==='bike'&&l.rentedBike&&p.bikeSource==='citiBike'?rentalDuration(l,p):l.duration;
    let wait=0,ride=rideSeconds/60,realtime=false,source='OpenStreetMap travel estimate',departure=clock,arrival=clock+rideSeconds*1000,bikePickup,bikeReturn,predictionReportedAt,tripId=l.trip?.gtfsId,stopDetails={};
    if(mode==='subway'||mode==='bus'){
      const ready=clock+(boardings>0?90000:45000)+(l.extraAccessMinutes||0)*60000;
      const live=backwards?backwards.connections.get(i):store.connection({line,tripId:l.pinnedTripId,fromStop:placeId(l.from.stop?.gtfsId),toStop:placeId(l.to.stop?.gtfsId),readyAt:ready,kind:mode});
      if(l.pinnedTripId&&!live)return null;
      if(live){if(live.departure<ready)return null;departure=live.departure;arrival=live.arrival;tripId=live.tripId;realtime=true;source='MTA live stop predictions';predictionReportedAt=live.sourceTimestamp?new Date(live.sourceTimestamp).toISOString():undefined;}
      else {
        if(p.requireLiveTransit)return null;
        departure=timestamp(l.start);arrival=timestamp(l.end);
        if(!Number.isFinite(departure)||!Number.isFinite(arrival)||departure<ready)return null;
        source=mode==='bus'&&!store.busKey?'MTA schedule · Bus Time key not connected':'MTA schedule · live prediction unavailable';allLive=false;
      }
      wait=(departure-clock)/60000;ride=(arrival-departure)/60000;boardings++;transitRides++;
      stopDetails=routeStopDetails(l,mode,live,store);
      if(boardings===1)fare+=300;
      // Fare is an estimate: subway transfers stay in the paid system; a third bus boarding can cost another fare.
      if(boardings>2&&mode==='bus')fare+=300;
    }
    if(mode==='bike'&&p.bikeSource==='citiBike'){
      if(!l.rentedBike||store.status().bikes.stale)return null;
      bikePickup=stations.get(placeId(l.from.vehicleRentalStation?.stationId));bikeReturn=stations.get(placeId(l.to.vehicleRentalStation?.stationId));
      if(!freshBikeStation(bikePickup)||!freshBikeStation(bikeReturn)||!bikePickup.isRenting||!bikeReturn.isReturning||!(bikeReturn.docks>0))return null;
      if(lowAssist?(!p.citiBikeMember||!lowAssistPickup(bikePickup)):!(bikePickup.classicBikes>0))return null;
      fare+=p.citiBikeMember?Math.max(0,Math.ceil(ride-45))*27:499+Math.max(0,Math.ceil(ride-30))*41;
      source='Live Citi Bike availability · estimated street time';
    }
    const from=i===0?request.origin:handoffLabel(l.from,raw.legs[i-1].to);
    const to=i===raw.legs.length-1?request.destination:handoffLabel(l.to,raw.legs[i+1].from);
    const bikeName=p.bikeSource==='ownBike'?'your bike':lowAssist?'a low-assist Citi Bike':'a classic Citi Bike';
    const instruction=mode==='walk'?`Walk to ${to.name}`:mode==='bike'?`Ride ${bikeName} to ${to.name}`:`Take the ${line} ${l.headsign?`toward ${l.headsign}`:`to ${to.name}`}`;
    const duration=(arrival-clock)/60000;
    const coveredTransfer=mode==='walk'&&l.from.stop?.parentStation?.gtfsId&&l.from.stop.parentStation.gtfsId===l.to.stop?.parentStation?.gtfsId;
    const outdoor=mode==='walk'?(coveredTransfer?0:duration):mode==='bike'?duration:mode==='bus'?wait:wait*(1-isUnderground(l.from.stop?.gtfsId));
    const underground=mode==='subway'?ride*undergroundFraction(l)+wait*isUnderground(l.from.stop?.gtfsId):coveredTransfer?duration:0;
    const coordinates=l.coordinates|| (l.legGeometry?.points?decodePolyline(l.legGeometry.points):[from.coordinate,to.coordinate]);
    const stops = line ? {boardStopId:placeId(l.from.stop?.gtfsId),alightStopId:placeId(l.to.stop?.gtfsId)} : {};
    legs.push({id:String(l.id||i)+'-'+mode,from,to,mode,line,tripId,...stops,...stopDetails,duration,
      distanceMeters:Number.isFinite(l.distance)&&l.distance>0?l.distance:undefined,headsign:l.headsign||undefined,
      waitingMinutes:wait,setupMinutes:mode==='bike'&&l.rentedBike?2:0,outdoorMinutes:outdoor,undergroundMinutes:underground,instruction,coordinates,bikeSource:mode==='bike'?p.bikeSource:undefined,bikeRideType:l.bikeRideType,realtime,dataSource:source,predictionReportedAt,departureTime:new Date(departure).toISOString(),arrivalTime:new Date(arrival).toISOString(),routeColor:l.route?.color||null,bikePickup,bikeReturn,steps:l.steps||[]});
    clock=arrival;
  }
  const sum=(key,filter=()=>true)=>legs.filter(filter).reduce((v,l)=>v+l[key],0);
  const walkingMinutes=sum('duration',l=>l.mode==='walk'),bikingMinutes=sum('duration',l=>l.mode==='bike');
  if(fare>p.maxFareCents||walkingMinutes>p.maxWalkingMinutes||bikingMinutes>p.maxBikingMinutes||Math.max(0,boardings-1)>p.maxTransfers||(request.arriveBy!=null&&(clock>request.arriveBy||clock<request.arriveBy-90*60000)))return null;
  const liveTransitSummary=legs.some(l=>l.mode==='bus')?(legs.some(l=>l.mode==='subway')?'Live train & bus predictions':'Live bus predictions'):'Live train predictions';
  const routeKey=legs.map(l=>`${l.mode}:${l.line||''}:${l.from.id}:${l.to.id}`).join('|')+p.bikeSource;
  const minutes=(clock-start)/60000,lowAssist=legs.some(leg=>leg.bikeRideType==='lowAssist');
  const fareAssumption=lowAssist?'Annual member · low assist if offered · tax excluded':p.bikeSource==='ownBike'?'Transit fare estimate':p.citiBikeMember?'Annual member · classic bikes · tax excluded':'Single classic rides · tax excluded';
  return {id:crypto.createHash('sha256').update(routeKey+(lowAssist?'|lowAssist':'')).digest('hex').slice(0,20),legs,minutes,fareCents:fare,outdoorMinutes:sum('outdoorMinutes'),undergroundMinutes:sum('undergroundMinutes'),walkingMinutes,bikingMinutes,transfers:Math.max(0,boardings-1),explanation:'',isSample:false,generatedAt:new Date().toISOString(),arrivalTime:new Date(clock).toISOString(),departureTime:new Date(start).toISOString(),dataQuality:allLive?'live':'scheduled',dataSummary:transitRides?(allLive?liveTransitSummary:'Includes scheduled transit'):bikingMinutes&&p.bikeSource==='citiBike'?'Live bike & dock reports':'Street travel estimate',fareAssumption,...(lowAssist?{lowAssistMinutesSaved:raw.classicComparisonSeconds/60-minutes}:{})};
}

function lowAssistExplanation(saved){
  const difference=Math.round(Math.abs(saved));
  return difference?`About ${difference} min ${saved>0?'quicker':'longer'} door to door than the classic bike option. Confirm low assist at unlock.`:'About the same time as a classic bike. Confirm low assist at unlock.';
}

export function rank(routes,p){
  const metrics=r=>[r.minutes,r.fareCents,r.outdoorMinutes,r.undergroundMinutes,r.walkingMinutes,r.bikingMinutes,r.transfers];
  const unique=[...new Map(routes.map(r=>[[r.id,r.departureTime,r.arrivalTime,...metrics(r)].join('|'),r])).values()];
  const frontier=unique.filter(c=>!unique.some(o=>{const a=metrics(o),b=metrics(c);return a.every((x,i)=>x<=b[i])&&a.some((x,i)=>x<b[i]);}));
  const customHasWeight=[p.timeWeight,p.costWeight,p.outsideWeight,p.undergroundWeight].some(v=>v>0);
  const score=r=>p.priority==='cost'?[r.fareCents,r.minutes]:p.priority==='aboveGround'?[r.undergroundMinutes,r.minutes]:p.priority==='sheltered'?[r.outdoorMinutes,r.minutes]:p.priority==='custom'?[customHasWeight?p.timeWeight*r.minutes/60+p.costWeight*r.fareCents/1000+p.outsideWeight*r.outdoorMinutes/30+p.undergroundWeight*r.undergroundMinutes/30:r.minutes,r.minutes]:[r.minutes,r.fareCents];
  frontier.sort((a,b)=>{const x=score(a),y=score(b);return x[0]-y[0]||x[1]-y[1]||a.bikingMinutes-b.bikingMinutes||Date.parse(b.departureTime||0)-Date.parse(a.departureTime||0);});
  const signatures=new Set(),result=[];
  const conventional=unique.reduce((best,r)=>!r.legs.some(l=>l.mode==='bike')&&(!best||r.minutes<best.minutes)?r:best,null);
  for(const r of frontier){
    const tokens=r.legs.filter(l=>l.mode!=='walk').map(l=>`${l.mode}:${l.line||l.bikeRideType||''}`),sig=tokens.filter((v,i)=>!i||v!==tokens[i-1]).join(',');
    if(signatures.has(sig))continue;signatures.add(sig);
    const saved=r.bikingMinutes&&conventional?Math.floor(conventional.minutes-r.minutes):0;
    if(saved>0)r.conventionalMinutesSaved=saved;
    const walk=r.legs.every(leg=>leg.mode==='walk');
    const savings=conventional?.legs.every(leg=>leg.mode==='walk')?'walking':'the quickest transit option found';
    r.explanation=Number.isFinite(r.lowAssistMinutesSaved)?lowAssistExplanation(r.lowAssistMinutesSaved):p.priority==='fastest'?(saved>0?`This bike route saves about ${saved} min compared with ${savings}.`:'Earliest arrival among the connections found within your limits.'):p.priority==='cost'?(walk?'Walking is free.':r.bikingMinutes&&r.fareCents===0?'Classic-bike ride included with your annual membership.':'Lowest estimated fare, with arrival time used to break ties.'):p.priority==='aboveGround'?(r.undergroundMinutes<1?'Above ground throughout this route.':`About ${Math.ceil(r.undergroundMinutes)} min underground, estimated from MTA station structures.`):p.priority==='sheltered'?`About ${Math.ceil(r.outdoorMinutes)} min outside, including walks, cycling and outdoor waits.`:'Balanced using your custom priorities and hard limits.';
    result.push(r);if(result.length===6)break;
  }
  return result;
}

// Search real-time one-train bike connections explicitly, including stations beyond walking range.
async function bikeConnections(request,store,searcher=search,candidateLimit=8,egressBike=false){
  const p=request.preferences;if(!p.modes.includes('bike')||!p.modes.includes('subway')||p.maxBikingMinutes===0)return[];
  const candidates=new Map(),stops=tripIndex.stops||{},seenPerLine=new Map();
  for(const [name,entry] of store.entries){
    if(!subwayFeeds.includes(name)||store.freshness(name).stale)continue;
    for(const entity of entry.message?.entity||[]){
      const update=entity.tripUpdate;if(entity.isDeleted||!update?.trip||[3,7].includes(update.trip.scheduleRelationship))continue;
      const line=update.trip.routeId,updates=update.stopTimeUpdate||[];
      for(let i=0;i<updates.length-1;i++){
        const from=stops[updates[i].stopId];if(!from||[1,2].includes(updates[i].scheduleRelationship))continue;const access=distance(request.origin.coordinate,from);
        if(egressBike?access>Math.min(1400,p.maxWalkingMinutes*60*walkingSpeed(p)):access>Math.min(6000,p.maxBikingMinutes*60*classicCyclingSpeed)||access<350)continue;
        const dep=Number((updates[i].departure?.time||updates[i].arrival?.time||0).toString())*1000;
        if(dep<request.depart+access/(egressBike?walkingSpeed(p):classicCyclingSpeed)*1000+(egressBike?45000:120000)||dep>request.depart+5400000)continue;
        for(let j=i+1;j<updates.length;j++){
          const to=stops[updates[j].stopId];if(!to||[1,2].includes(updates[j].scheduleRelationship))continue;const egress=distance(request.destination.coordinate,to);if(egressBike?egress>Math.min(6000,p.maxBikingMinutes*60*classicCyclingSpeed)||egress<350:egress>Math.min(1400,p.maxWalkingMinutes*60*walkingSpeed(p)))continue;
          const arr=Number((updates[j].arrival?.time||updates[j].departure?.time||0).toString())*1000;if(arr<dep)continue;
          const key=line+':'+updates[i].stopId.replace(/[NS]$/,'')+':'+updates[j].stopId.replace(/[NS]$/,''),estimate=arr+egress/(egressBike?classicCyclingSpeed:walkingSpeed(p))*1000+(egressBike?120000:0);
          if(!candidates.has(key)||estimate<candidates.get(key).estimate)candidates.set(key,{line,fromId:updates[i].stopId,toId:updates[j].stopId,from,to,updates:updates.slice(i,j+1),trip:update.trip,dep,arr,estimate});
        }
      }
    }
  }
  const chosen=[...candidates.values()].sort((a,b)=>a.estimate-b.estimate).filter(c=>{const n=seenPerLine.get(c.line)||0;if(n>=2)return false;seenPerLine.set(c.line,n+1);return true;}).slice(0,candidateLimit);
  const bike=p.bikeSource==='ownBike'?'BICYCLE':'BICYCLE_RENTAL';
  const results=await Promise.allSettled(chosen.map(async c=>{
    const bikeModes=[...(bike==='BICYCLE_RENTAL'?['WALK']:[]),bike];
    const access=await searcher(toInput(request.origin),stopInput(c.fromId),{direct:egressBike?['WALK']:bikeModes,directOnly:true},p,request.depart);
    const a=egressBike?access[0]:access.find(r=>r.legs.some(l=>l.mode==='BICYCLE'));if(!a)return null;
    const egress=await searcher(stopInput(c.toId),toInput(request.destination),{direct:egressBike?bikeModes:['WALK'],directOnly:true},p,c.arr);
    const e=egressBike?egress.find(r=>r.legs.some(l=>l.mode==='BICYCLE')):egress[0];if(!e)return null;
    const geometry=subwayJourneyPoints(store,{line:c.line,tripId:c.trip.tripId,stopIds:c.updates.map(call=>call.stopId)});
    const rawPlace=(s,id)=>({name:s.name,lat:s.latitude,lon:s.longitude,stop:{gtfsId:'nyct:'+id}});
    const transit={mode:'SUBWAY',duration:(c.arr-c.dep)/1000,from:rawPlace(c.from,c.fromId),to:rawPlace(c.to,c.toId),route:{shortName:c.line,color:tripIndex.routes?.[c.line]?.route_color},start:{estimated:{time:new Date(c.dep).toISOString()}},end:{estimated:{time:new Date(c.arr).toISOString()}},coordinates:geometry,stopCalls:c.updates.map(u=>({stopLocation:{gtfsId:'nyct:'+u.stopId}}))};
    return {legs:[...a.legs,transit,...e.legs]};
  }));
  return results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
}

export function searchFamilies(p,busConnected){
  const transit=[];if(p.modes.includes('subway'))transit.push({mode:'SUBWAY'});if(p.modes.includes('bus')&&p.bikeSource!=='ownBike'&&(!p.requireLiveTransit||busConnected))transit.push({mode:'BUS'});
  // Mixed searches can prune a whole mode before Crosstown compares its priorities.
  const families=[{direct:['WALK'],directOnly:true}];
  const transitSearch=modes=>({direct:['WALK'],transit:{access:['WALK'],egress:['WALK'],transfer:['WALK'],transit:modes}});
  if(transit.length===1||transit.length>1&&p.maxTransfers>0)families.push(transitSearch(transit));
  if(transit.length>1)for(const mode of transit)families.push(transitSearch([mode]));
  if(p.modes.includes('bike')&&p.maxBikingMinutes>0){
    const bike=p.bikeSource==='ownBike'?'BICYCLE':'BICYCLE_RENTAL',mixed=bike==='BICYCLE_RENTAL'?['WALK',bike]:[bike];
    families.push({direct:mixed,directOnly:true});
    if(transit.length){
      if(p.bikeSource==='ownBike')families.push({direct:mixed,transit:{access:mixed,egress:mixed,transfer:['BICYCLE'],transit}});
      else for(const [access,egress]of [[mixed,['WALK']],[['WALK'],mixed],[mixed,mixed]])families.push({direct:mixed,transit:{access,egress,transfer:['WALK'],transit}});
    }
  }
  return families;
}

export function primaryTransitMode(route){
  const riding = new Map();
  for(const leg of route.legs){
    if(leg.mode==='walk')continue;
    const stationary = (leg.mode==='bike'?leg.setupMinutes:leg.waitingMinutes)??0;
    riding.set(leg.mode,(riding.get(leg.mode)||0)+Math.max(0,(leg.duration??0)-stationary));
  }
  const total = [...riding.values()].reduce((sum,minutes)=>sum+minutes,0);
  return ['subway','bus'].find(mode=>riding.has(mode)&&(riding.size===1||riding.get(mode)>total/2));
}

export function bestRoutes(valid,p){
  const eligible=p.priority==='sheltered'?valid.filter(route=>
    route.legs.some(leg=>leg.mode==='subway'||leg.mode==='bus')&&route.legs.every(leg=>leg.mode!=='bike')):valid;
  return rank(eligible,p);
}

export function compareModes(valid,p,transitCandidates){
  const bikes=rank(valid.filter(route=>route.legs.some(leg=>leg.mode==='bike')),p);
  const lowAssist=valid.find(route=>Number.isFinite(route.lowAssistMinutesSaved));
  if(lowAssist&&!bikes.some(route=>route.id===lowAssist.id)){
    bikes.splice(5);
    bikes.push({...lowAssist,explanation:lowAssistExplanation(lowAssist.lowAssistMinutesSaved)});
  }
  return {
    subway:rank(transitCandidates?.subway??valid.filter(route=>primaryTransitMode(route)==='subway'),p),
    bus:rank(transitCandidates?.bus??valid.filter(route=>primaryTransitMode(route)==='bus'),p),
    bike:bikes,
    walk:rank(valid.filter(route=>route.legs.every(leg=>leg.mode==='walk')),p),
  };
}

function fasterSubwayTransfers(pairs,request,store){
  const possible=pairs.filter(pair=>pair.route.transfers<request.preferences.maxTransfers&&pair.route.legs.some(leg=>leg.mode==='subway'&&leg.realtime));
  if(!possible.length)return [];
  const search=createSubwayTransferSearch(store,request),memo=new Map(),options=[];
  for(const pair of possible){
    const {raw,route}=pair,available=request.preferences.maxTransfers-route.transfers;
    let boardings=0;
    for(const [index,leg] of route.legs.entries()){
      if(leg.mode!=='subway'&&leg.mode!=='bus')continue;
      const boardingSlack=boardings++?90000:45000;
      if(leg.mode!=='subway'||!leg.realtime)continue;
      const start=Date.parse(leg.departureTime)-leg.waitingMinutes*60000,rawLeg=raw.legs[index];
      const ready=(request.arriveBy!=null?request.depart:start)+boardingSlack+(rawLeg.extraAccessMinutes||0)*60000;
      const arriveBefore=Date.parse(leg.arrivalTime);
      const key=[leg.boardStopId,leg.alightStopId,leg.line,ready,arriveBefore,available].join('|');
      if(!memo.has(key))memo.set(key,search(rawLeg,ready,arriveBefore,available));
      for(const replacement of memo.get(key)){
        const variant={legs:[...raw.legs.slice(0,index),{...replacement[0],extraAccessMinutes:rawLeg.extraAccessMinutes},...replacement.slice(1),...raw.legs.slice(index+1)]};
        const result=normalize(variant,request,store);
        if(result&&result.minutes+1/60<route.minutes)options.push({raw:variant,route:result});
      }
    }
  }
  return options;
}

export async function route(input,store,{searcher=search,feedsReady={},onPreview,bikeCandidateLimit=8,rentalTransitFamilies=true,egressBikeConnections=false,lowAssistPickupLimit=4}={}){
  const request=validateRequest(input),p=request.preferences,families=searchFamilies(p,Boolean(store.busKey)).filter(m=>rentalTransitFamilies||!JSON.stringify(m.transit||{}).includes('BICYCLE_RENTAL'));
  const checks=families.map(async modes=>{
    if(modes.direct.includes('BICYCLE_RENTAL'))await feedsReady.bike;
    return searcher(toInput(request.origin),toInput(request.destination),modes,p,request.arriveBy??request.depart,request.arriveBy!=null);
  });
  if(onPreview){
    let shown=false;
    for(const check of checks)void check.then(async raws=>{
      if(shown||!raws.length)return;
      const modes=new Set(raws.flatMap(raw=>raw.legs.map(leg=>leg.mode)));
      await Promise.all([modes.has('SUBWAY')&&feedsReady.subway,modes.has('BUS')&&feedsReady.bus]);
      if(shown)return;
      const snapshot=predictionSnapshot(store),available=raws.map(raw=>normalize(raw,request,snapshot)).filter(Boolean);
      const first=bestRoutes(available,p)[0];
      if(first){shown=true;onPreview(first);}
    }).catch(()=>{});
  }
  const bikeConnectionsDone=Promise.allSettled([false,...(egressBikeConnections?[true]:[])].map(async egress=>{
    if(!p.modes.includes('bike')||!p.modes.includes('subway')||p.maxBikingMinutes===0)return [];
    await Promise.all([feedsReady.subway,feedsReady.bike]);
    if(!rentalTransitFamilies&&p.bikeSource==='citiBike'&&store.status().bikes.stale)return [];
    return bikeConnections(request,store,searcher,bikeCandidateLimit,egress);
  }));
  const [results]=await Promise.all([Promise.allSettled(checks),...Object.values(feedsReady)]);
  let raw=results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value);
  const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason.message);
  if(!raw.length&&errors.length===results.length)throw results[0].reason;
  const lowAssist=lowAssistTrip(raw,request,store,{search:searcher,distance,pickupLimit:lowAssistPickupLimit,
    geometry:leg=>leg.coordinates||(leg.legGeometry?.points?decodePolyline(leg.legGeometry.points):[coordinate(leg.from),coordinate(leg.to)])})
    .catch(error=>{errors.push(error.message);return null;});
  const [extraBikes,choice]=await Promise.all([bikeConnectionsDone,lowAssist]);
  for(const result of extraBikes){
    if(result.status==='fulfilled')raw.push(...result.value);
    else errors.push(result.reason.message);
  }
  if(choice)raw.push(choice);
  const snapshot=predictionSnapshot(store),pairs=raw.map(raw=>({raw,route:normalize(raw,request,snapshot)})).filter(pair=>pair.route);
  const faster=fasterSubwayTransfers(pairs,request,snapshot);
  pairs.push(...faster);
  const options=subwayOptions(pairs,request,snapshot,{normalize,rank,primaryTransitMode,
    geometry:connection=>subwayJourneyPoints(snapshot,connection,{requireShape:true})});
  const routeGroups=compareModes(options.primaries,p,options.transitCandidates),routes=bestRoutes(options.primaries,p),used=new Set([...routes,...Object.values(routeGroups).flat()].flatMap(route=>route.alternativeIds||[])),alternativeRoutes=Object.fromEntries(Object.entries(options.alternativeRoutes).filter(([id])=>used.has(id)));
  if(request.arriveBy!=null&&p.priority==='fastest')for(const r of [...routes,...Object.values(routeGroups).flat()])if(!Number.isFinite(r.lowAssistMinutesSaved))r.explanation='Shortest travel time among the connections found that meet your arrival deadline and limits.';
  return {routes,routeGroups,alternativeRoutes,searchBounds:{resultsPerFamily:10,windowMinutes:90,extraBikeConnections:8,lowAssistPickupLimit},notice:'MTA stop predictions and current Citi Bike station reports. Street travel and outdoor exposure are estimates. Availability can change before arrival.',consideredRoutes:raw.length+faster.length,validRoutes:pairs.length,optimality:'best-found-within-bounded-search',timing:{mode:request.arriveBy!=null?'arriveBy':request.departureTime?'departAt':'now',time:new Date(request.arriveBy??request.depart).toISOString()},isSample:false,generatedAt:new Date().toISOString(),feedStatus:store.status(),searchedFamilies:families.length+1,excludedScheduled:p.requireLiveTransit,partialSearch:errors.length>0,warnings:[...(!store.busKey?['Live bus predictions need a Bus Time API key. Bus schedules are only included if you turn off live-only transit.']:[]),...errors.map(()=> 'One route family could not be checked.')].filter((v,i,a)=>a.indexOf(v)===i)};
}
