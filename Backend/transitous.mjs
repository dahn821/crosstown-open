import crypto from 'node:crypto';
import {walkingSpeed} from './walking.mjs';
import {classicCyclingSpeed,rentalLeg} from './citi-bike.mjs';

const endpoint='https://api.transitous.org/api/v6/plan';
const meters=(a,b)=>Math.hypot((a.latitude-b.latitude)*111200,(a.longitude-b.longitude)*84200);
export function decodeGeometry(value,precision=6){
  const points=[];let offset=0,latitude=0,longitude=0;
  const number=()=>{let result=0,shift=0,byte;do{if(offset>=value.length||shift>30)throw Error('Invalid route geometry');byte=value.charCodeAt(offset++)-63;result|=(byte&31)<<shift;shift+=5;}while(byte>=32);return result&1?~(result>>1):result>>1;};
  while(offset<value.length){latitude+=number();longitude+=number();points.push({latitude:latitude/10**precision,longitude:longitude/10**precision});}
  return points;
}
const mtaStop=place=>{
  const id=place?.stopId;
  if(!id)return null;
  if(id.startsWith('us-ny-MTA-NYCSubway_'))return 'nyct:'+id.slice('us-ny-MTA-NYCSubway_'.length);
  if(/^us-ny-MTA-(?:Bus|NYCT|MTABC)/.test(id))return 'mta:'+id.split('_').at(-1);
  return null;
};
const rawPlace=place=>({name:place.name,lat:place.lat,lon:place.lon,...mtaStop(place)?{stop:{gtfsId:mtaStop(place),parentStation:{gtfsId:place.parentId||mtaStop(place).replace(/[NS]$/,'')}}}:{}});
export function transitousItinerary(itinerary){
  const legs=[];
  for(const leg of itinerary.legs||[]){
    const mode=leg.mode==='WALK'?'WALK':leg.mode==='BIKE'?'BICYCLE':leg.mode==='SUBWAY'?'SUBWAY':leg.mode==='BUS'?'BUS':null;
    if(!mode||leg.cancelled||!leg.from||!leg.to)return null;
    if(['SUBWAY','BUS'].includes(mode)&&(!mtaStop(leg.from)||!mtaStop(leg.to)||!leg.routeShortName))return null;
    const coordinates=decodeGeometry(leg.legGeometry?.points||'',leg.legGeometry?.precision??6);
    if(coordinates.length<2)return null;
    const stopCalls=Array.isArray(leg.intermediateStops)?[leg.from,...leg.intermediateStops,leg.to].map(stop=>({
      stopLocation:{gtfsId:mtaStop(stop),name:stop.name}
    })):undefined;
    legs.push({id:leg.tripId||String(legs.length),mode,duration:leg.duration,distance:leg.distance,from:rawPlace(leg.from),to:rawPlace(leg.to),route:leg.routeShortName?{shortName:leg.routeShortName,gtfsId:leg.routeId,color:leg.routeColor}:undefined,trip:leg.tripId?{gtfsId:leg.tripId}:undefined,headsign:leg.headsign||'',start:{scheduledTime:leg.scheduledStartTime||leg.startTime},end:{scheduledTime:leg.scheduledEndTime||leg.endTime},coordinates,stopCalls,steps:(leg.steps||[]).map(step=>{const point=decodeGeometry(step.polyline?.points||'',step.polyline?.precision??6)[0]||coordinates[0];return {distance:step.distance,relativeDirection:step.relativeDirection||'CONTINUE',absoluteDirection:step.absoluteDirection||'',streetName:step.streetName||'path',walkingBike:mode==='BICYCLE'&&step.walkingBike===true,lat:point.latitude,lon:point.longitude};})});
  }
  return legs.length?{legs}:null;
}

export function createTransitousSearch(store,{fetcher=fetch,cache=new Map(),beforeRequest=async()=>{},onRateLimit=()=>{},contact='https://github.com/dahn821/crosstown-open',leaveNow=true,now=Date.now,deadline}={}){
  const pending=new Map(),metrics={requests:0,cacheHits:0};
  const point=input=>{
    if(input.location.coordinate)return input.location.coordinate;
    const id=input.location.stopLocation?.stopLocationId?.split(':').at(-1),stop=store.tripIndex.stops?.[id];
    if(!stop)throw Error('This station is unavailable in the community router.');
    return {latitude:stop.latitude,longitude:stop.longitude};
  };
  async function plain(origin,destination,modes,preferences,instant,arriveBy=false,cyclingSpeed=classicCyclingSpeed){
    const from=point(origin),to=point(destination),transit=modes.transit?.transit?.map(item=>item.mode)||[],asMode=mode=>mode==='BICYCLE'?'BIKE':mode;
    const straightLine=meters(from,to);
    if(straightLine<3)return [{legs:[]}];
    const walkOnly=modes.directOnly&&modes.direct.length===1&&modes.direct[0]==='WALK';
    // A street path cannot beat the straight-line distance. Allow room for
    // map snapping and the approximate distance calculation.
    if(walkOnly&&(!preferences.modes.includes('walk')||preferences.maxWalkingMinutes===0||
      straightLine>walkingSpeed(preferences)*preferences.maxWalkingMinutes*60+200))return [];
    const hasPersonalPace=preferences.bikeSource==='citiBike'&&(preferences.classicBikePaceMph!=null||preferences.lowAssistBikePaceMph!=null);
    const bikeLimit=hasPersonalPace?Math.max(preferences.maxBikingMinutes,Math.min(120,preferences.maxBikingMinutes*2)):preferences.maxBikingMinutes;
    const parameters={fromPlace:`${from.latitude},${from.longitude}`,toPlace:`${to.latitude},${to.longitude}`,time:new Date(instant).toISOString(),arriveBy:String(arriveBy),pedestrianSpeed:String(walkingSpeed(preferences)),cyclingSpeed:String(cyclingSpeed),transitModes:transit.join(','),directModes:modes.directOnly?modes.direct.map(asMode).join(','):'',preTransitModes:(modes.transit?.access||['WALK']).map(asMode).join(','),postTransitModes:(modes.transit?.egress||['WALK']).map(asMode).join(','),maxTransfers:String(preferences.maxTransfers),minTransferTime:'45',additionalTransferTime:'90',maxPreTransitTime:String(Math.min(900,(modes.transit?.access?.includes('BICYCLE')?preferences.maxBikingMinutes:preferences.maxWalkingMinutes)*60)),maxPostTransitTime:String(Math.min(900,(modes.transit?.egress?.includes('BICYCLE')?preferences.maxBikingMinutes:preferences.maxWalkingMinutes)*60)),maxDirectTime:String((modes.direct?.includes('BICYCLE')?bikeLimit:preferences.maxWalkingMinutes)*60),numItineraries:'10',maxItineraries:'10',searchWindow:'900',numLegAlternatives:'0'};
    if(transit.length&&preferences.bikeSource==='ownBike'&&modes.transit.access.includes('BICYCLE'))parameters.requireBikeTransport='true';
    const streetOnly=modes.directOnly&&transit.length===0;
    const cacheParameters=streetOnly?{fromPlace:parameters.fromPlace,toPlace:parameters.toPlace,
      directModes:parameters.directModes,pedestrianSpeed:parameters.pedestrianSpeed,
      cyclingSpeed:walkOnly?undefined:parameters.cyclingSpeed,maxDirectTime:parameters.maxDirectTime}:
      {...parameters,time:leaveNow?'current-topology':parameters.time};
    const key=crypto.createHash('sha256').update(JSON.stringify(cacheParameters)).digest('hex'),cached=await cache.get(key);
    if(cached&&cached.until>now()){metrics.cacheHits++;return cached.routes;}
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      deadline?.throwIfAborted();
      await beforeRequest(deadline);
      deadline?.throwIfAborted();
      metrics.requests++;
      const url=new URL(endpoint);url.search=new URLSearchParams(parameters).toString();
      const timeout=AbortSignal.timeout(7500);
      const signal=deadline?AbortSignal.any([timeout,deadline]):timeout;
      const response=await fetcher(url,{headers:{'User-Agent':`Crosstown/0.3 (${contact})`},redirect:'error',signal});
      if(response.status===429){
        onRateLimit(response.headers.get('Retry-After'));
        throw Object.assign(Error('Community routing is busy. Please try again shortly.'),{status:429});
      }
      if(!response.ok)throw Error(`Community routing is unavailable (HTTP ${response.status}). Please try again.`);
      const data=await response.json(),list=modes.directOnly?data.direct:data.itineraries;
      if(!Array.isArray(list))throw Error('The community router returned an invalid result.');
      const routes=list.map(transitousItinerary).filter(Boolean);
      if(cache.size>=150)cache.delete(cache.keys().next().value);
      await cache.set(key,{routes,until:now()+(streetOnly||leaveNow&&preferences.requireLiveTransit?900000:60000)});return routes;
    })().finally(()=>pending.delete(key));pending.set(key,task);return task;
  }
  async function rental(origin,destination,preferences,instant){
    if(store.status().bikes.stale)return [];
    const from=point(origin),to=point(destination),stations=store.bikeStations(),picks=stations.filter(station=>station.isRenting&&station.classicBikes>0&&meters(from,station.coordinate)<=700).sort((a,b)=>meters(from,a.coordinate)-meters(from,b.coordinate)).slice(0,2),returns=stations.filter(station=>station.isReturning&&station.docks>0&&meters(to,station.coordinate)<=700).sort((a,b)=>meters(to,a.coordinate)-meters(to,b.coordinate)).slice(0,2);
    const pairs=picks.flatMap(pick=>returns.filter(drop=>drop.id!==pick.id).map(drop=>({pick,drop,score:meters(from,pick.coordinate)+meters(to,drop.coordinate)}))).sort((a,b)=>a.score-b.score).slice(0,1);
    const input=station=>({label:station.name,location:{coordinate:station.coordinate}}),stationPlace=station=>({name:station.name,lat:station.coordinate.latitude,lon:station.coordinate.longitude,vehicleRentalStation:{stationId:'citibike:'+station.id}});
    const results=await Promise.all(pairs.map(async({pick,drop})=>{
      const [access,ride,egress]=await Promise.all([plain(origin,input(pick),{direct:['WALK'],directOnly:true},preferences,instant),plain(input(pick),input(drop),{direct:['BICYCLE'],directOnly:true},preferences,instant),plain(input(drop),destination,{direct:['WALK'],directOnly:true},preferences,instant)]);
      if(!access[0]||!ride[0]||!egress[0])return null;
      const bike=rentalLeg(ride[0].legs,stationPlace(pick),stationPlace(drop),leg=>leg.coordinates);
      return {legs:[...access[0].legs,bike,...egress[0].legs]};
    }));return results.filter(Boolean);
  }
  const search=async(origin,destination,modes,preferences,instant,arriveBy=false,{cyclingSpeed=classicCyclingSpeed}={})=>modes.directOnly&&modes.direct.includes('BICYCLE_RENTAL')?rental(origin,destination,preferences,instant):plain(origin,destination,modes,preferences,instant,arriveBy,cyclingSpeed);
  return {search,metrics};
}
