import {FeedStore,subwayFeeds} from './feeds.mjs';
import {createPlaceSearch} from './places.mjs';
import {route,configureRoutingData,validateRequest} from './otp.mjs';
import {createTransitousSearch} from './transitous.mjs';
import {vehicleQuery,vehicleSnapshot} from './vehicles.mjs';
import {vehicleTrip,vehicleTripQuery} from './vehicle-trip.mjs';
import {ridePrediction,rideQuery} from './ride.mjs';
import {bikeStationSnapshot} from './citi-bike.mjs';
import {nearbySubwayBoard,stationRadius} from './subway-stations.mjs';
import {nearbyBusBoard,busStopRadius} from './bus-stops.mjs';
import {setTimeout as wait} from 'node:timers/promises';

const meters=(a,b)=>Math.hypot((a.latitude-b.latitude)*111200,(a.longitude-b.longitude)*84200);
const withinNYC=point=>Number.isFinite(point.latitude)&&Number.isFinite(point.longitude)&&point.latitude>=40.48&&point.latitude<=40.94&&point.longitude>=-74.27&&point.longitude<=-73.67;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, noarchive'}});

export function createCommunityAPI({lookup,restaurants,busKey='',subwayShapeData,beforeRequest=async()=>{},fetcher=fetch,contact='https://github.com/dahn821/crosstown-open'}={}){
 configureRoutingData({stations:lookup.stationStructures,index:lookup.index});
 const store=new FeedStore({tripIndex:lookup.index,stationStructures:lookup.stationStructures,busStops:lookup.busStops,subwayShapeData,busKey,fetcher}),cache=new Map();
 const subwayRoutes=Object.entries(lookup.index.routes||{}).map(([shortName,route])=>({shortName,color:route.route_color}));
 const transitStops=[...Object.entries(lookup.index.stops).map(([id,stop])=>({gtfsId:'nyct:'+id,name:stop.name,lat:stop.latitude,lon:stop.longitude,vehicleMode:'SUBWAY',routes:subwayRoutes})),...lookup.busStops.map(stop=>({...stop,vehicleMode:'BUS',routes:[]}))];
 const landmarks=[{id:'penn',name:'Penn Station',neighborhood:'Midtown West',coordinate:{latitude:40.7505,longitude:-73.9934},selectable:true},{id:'ues',name:'96 St & Lexington Ave',neighborhood:'Upper East Side',coordinate:{latitude:40.785,longitude:-73.9518},selectable:true}];
 const places=createPlaceSearch({restaurants:restaurants.restaurants,landmarks,dataUpdatedAt:restaurants.dataUpdatedAt,fetcher});
 const loaders=new Map([
   ...subwayFeeds.map(feed=>[feed,()=>store.refreshSubway(feed)]),
   ['bus',()=>store.refreshBus()],['busVehicles',()=>store.refreshBusVehicles()],['bikes',()=>store.refreshBikes()]
 ]);
 const activeFeeds=new Map(),checkedAt=new Map();
 let activePlans=0;
 let requestQueue=Promise.resolve(),lastRequestAt=0,pausedUntil=0;
 const busy=()=>Object.assign(Error('Community routing is busy. Please try again shortly.'),{status:429});
 function reserveProviderRequest(signal){
   const job=requestQueue.then(async()=>{
     signal?.throwIfAborted();
     if(Date.now()<pausedUntil)throw busy();
     const gap=lastRequestAt+500-Date.now();
     if(gap>0)await wait(gap,undefined,{signal});
     if(Date.now()<pausedUntil)throw busy();
     await beforeRequest(signal);
     lastRequestAt=Date.now();
   });
   requestQueue=job.catch(()=>{});
   return job;
 }
 function pauseProvider(retryAfter){
   const now=Date.now(),delay=retryAfter==null?30000:/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:Date.parse(retryAfter)-now;
   pausedUntil=Math.max(pausedUntil,now+(Number.isFinite(delay)?Math.max(1000,delay):30000));
 }
 async function feeds(names=loaders.keys(),timeout=4500){
   const updates=[];
   for(const name of names){
     let job=activeFeeds.get(name);
     if(!job&&Date.now()-(checkedAt.get(name)||0)>25000){
       job=loaders.get(name)().finally(()=>{checkedAt.set(name,Date.now());activeFeeds.delete(name);});
       activeFeeds.set(name,job);
     }
     if(job)updates.push(job);
   }
   if(!updates.length)return;
   let timer;
   await Promise.race([Promise.allSettled(updates),new Promise(resolve=>{
     timer=setTimeout(resolve,timeout);timer.unref?.();
   })]).finally(()=>clearTimeout(timer));
 }
 return async function handle(request){
  try{
   const url=new URL(request.url),pathname=url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/)/,'/api');
   if(pathname==='/api/ready')return json({ready:true});
   if(pathname==='/api/places'&&request.method==='GET')return json(await places(url.searchParams.get('q')));
   if((pathname==='/api/ride'||pathname==='/api/vehicle-trip')&&request.method==='GET'){
     const tracking=pathname==='/api/vehicle-trip';
     const query=(tracking?vehicleTripQuery:rideQuery)(url.searchParams);
     await feeds(tracking&&query.feed==='bus'?['bus','busVehicles']:[query.feed]);
     return json(tracking?await vehicleTrip(store,query):ridePrediction(store,query));
   }
   if(pathname==='/api/health'&&request.method==='GET'){
     if(url.searchParams.get('feeds')!=='0')await feeds();
     return json({service:'Crosstown',version:'0.3.0',router:{ready:true,message:'Community street routing with current MTA and Citi Bike checks.',engine:'MOTIS 2 / Transitous',mode:'community'},feeds:store.status(),coverage:'New York City, five boroughs',localSetupAvailable:false,community:{requestLimit:600,windowHours:24,source:'https://transitous.org/sources/'}});
   }
   if(pathname==='/api/plan'&&request.method==='POST'){
     if(activePlans>=2)return json({error:'Several routes are being checked. Please try again shortly.'},429);
     const text=await request.text();if(text.length>20000)return json({error:'Request too large.'},413);
     let input;try{input=JSON.parse(text);}catch{return json({error:'Invalid route request.'},400);}
     validateRequest(input);
     activePlans++;
     try{
       const deadline=AbortSignal.timeout(22000);
       await feeds([...subwayFeeds,'bus','bikes'],6000);
       const adapter=createTransitousSearch(store,{fetcher,cache,contact,leaveNow:!input.departureTime&&!input.arrivalTime,beforeRequest:reserveProviderRequest,onRateLimit:pauseProvider,deadline});
       const result=await route(input,store,{searcher:adapter.search,bikeCandidateLimit:1,rentalTransitFamilies:false,egressBikeConnections:true,lowAssistPickupLimit:2});
       result.router={engine:'MOTIS 2 / Transitous',mode:'community'};
       result.searchBounds={...result.searchBounds,windowMinutes:15,extraBikeConnections:2,bikeDockPairsPerAccess:1};
       result.notice='Routes use Transitous street and schedule data, checked against current MTA predictions and Citi Bike reports. Times are estimates and availability can change.';
       return json(result);
     }finally{activePlans--;}
   }
   if(pathname==='/api/bike-stations'&&request.method==='GET'){
     await feeds(['bikes']);
     return json(bikeStationSnapshot(store));
   }
   if(['/api/bikes','/api/transit','/api/vehicles'].includes(pathname)&&request.method==='GET'){
     if(pathname==='/api/vehicles'){
       const query=vehicleQuery(url.searchParams);
       await feeds([...(query.modes.includes('subway')?subwayFeeds:[]),...(query.modes.includes('bus')?['bus','busVehicles']:[])]);
       return json(vehicleSnapshot(store,query));
     }
     const coordinate={latitude:Number(url.searchParams.get('lat')),longitude:Number(url.searchParams.get('lon'))};
     if(!url.searchParams.has('lat')||!url.searchParams.has('lon')||!withinNYC(coordinate))return json({error:'Choose a start in New York City.'},400);
     if(pathname==='/api/bikes'){
       await feeds(['bikes']);
       if(!store.gbfs.get('station_status'))return json({error:'Current Citi Bike reports are unavailable.',status:store.status().bikes},503);
       const snapshot=bikeStationSnapshot(store);
       return json({...snapshot,stations:snapshot.stations.map(station=>({...station,metersAway:meters(coordinate,station.coordinate)})).filter(station=>station.metersAway<5000).sort((a,b)=>a.metersAway-b.metersAway).slice(0,20)});
     }
     if(url.searchParams.get('mode')==='subway'){
       await feeds(subwayFeeds);
       const board=nearbySubwayBoard(store,coordinate,{stop:url.searchParams.get('stop'),line:url.searchParams.get('line')});
       return json({...board,feedStatus:store.status(),generatedAt:new Date().toISOString(),radiusMeters:stationRadius});
     }
     if(url.searchParams.get('mode')==='bus'){
       await feeds(['bus']);
       const board=nearbyBusBoard(store,lookup.busStops,coordinate,{stop:url.searchParams.get('stop'),line:url.searchParams.get('line')});
       return json({...board,feedStatus:store.status(),generatedAt:new Date().toISOString(),radiusMeters:busStopRadius});
     }
     const stops=transitStops.map(stop=>({...stop,distance:meters(coordinate,{latitude:stop.lat,longitude:stop.lon})})).filter(stop=>stop.distance<=1200).sort((a,b)=>a.distance-b.distance);
     await feeds([...subwayFeeds,'bus']);
     return json({departures:store.departures(stops,Date.now(),{mode:url.searchParams.get('mode'),stop:url.searchParams.get('stop')}),feedStatus:store.status(),generatedAt:new Date().toISOString(),radiusMeters:1200});
   }
   return json({error:'Not found.'},404);
  }catch(error){const status=error.status||(/community routing limit/i.test(error.message)?429:502);return json({error:error.message||'The route service is unavailable.'},status);}
 };
}
