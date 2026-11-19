import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedStore,canonicalTripId,busID} from '../feeds.mjs';
import {nearbySubwayBoard} from '../subway-stations.mjs';

test('real GTFS SBS plus suffixes and Bus Company prefixes preserve route identity',()=>{
 for(const [provider,display]of [['MTA NYCT_M15+','M15-SBS'],['MTA NYCT_M34A+','M34A-SBS'],['MTABC_Q52+','Q52-SBS'],['MTA_403058','403058']])assert.equal(busID(provider),busID(display));
 assert.notEqual(busID('MTA NYCT_M15+'),busID('M15'));
 assert.notEqual(busID('MTABC_Q52+'),busID('Q53-SBS'));
});

test('Bus Time agency prefixes match borough schedule IDs without matching different routes',()=>{
 const now=Date.now(),store=new FeedStore({tripIndex:{},busKey:'test-only'});
 store.entries.set('bus',{sourceTimestamp:now,message:{entity:[{tripUpdate:{trip:{routeId:'MTA NYCT_M15+',tripId:'actual-bus'},stopTimeUpdate:[{stopId:'MTA_403058',departure:{time:Math.floor(now/1000)+120}},{stopId:'MTA_403059',arrival:{time:Math.floor(now/1000)+900}}]}}]}});
 assert.equal(store.connection({kind:'bus',line:'M15-SBS',fromStop:'403058',toStop:'403059',readyAt:now}).tripId,'actual-bus');
 assert.equal(store.connection({kind:'bus',line:'M15',fromStop:'403058',toStop:'403059',readyAt:now}),null);
});

test('runtime trip IDs map only to a service active on the provider service day',()=>{
 const index={trips:{'120000_6..N':[{id:'weekday_120000_6..N',service:'wd'},{id:'sunday_120000_6..N',service:'su'}]},calendars:{wd:{start:'20260101',end:'20261231',days:[1,1,1,1,1,0,0]},su:{start:'20260101',end:'20261231',days:[0,0,0,0,0,0,1]}},exceptions:{'20261116':{wd:2,su:1}}};
 assert.equal(canonicalTripId(index,'120000_6..N','20261117'),'weekday_120000_6..N');
 assert.equal(canonicalTripId(index,'120000_6..N','20261116'),'sunday_120000_6..N');
 assert.equal(canonicalTripId(index,'missing','20261117'),null);
});
function liveStore(){const now=Date.now(),store=new FeedStore({tripIndex:{}});store.entries.set('gtfs',{sourceTimestamp:now,fetchedAt:now,message:{entity:[{tripUpdate:{trip:{routeId:'6',tripId:'actual-train'},stopTimeUpdate:[{stopId:'632N',departure:{time:Math.floor(now/1000)+120}},{stopId:'625N',arrival:{time:Math.floor(now/1000)+900}}]}}]}});return{store,now};}
test('a reachable live train uses both reported stop predictions',()=>{
 const{store,now}=liveStore(),c=store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now+60000});
 assert.equal(c.tripId,'actual-train');assert(c.departure>now);assert(c.arrival>c.departure);
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'missing',readyAt:now}),null);
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now+180000}),null);
});
test('stale, canceled, skipped and reversed predictions are not used',()=>{
 for(const change of [s=>s.entries.get('gtfs').sourceTimestamp-=181000,s=>s.entries.get('gtfs').message.entity[0].tripUpdate.trip.scheduleRelationship=3,s=>s.entries.get('gtfs').message.entity[0].tripUpdate.stopTimeUpdate[0].scheduleRelationship=1]){
  const{store,now}=liveStore();change(store);assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now}),null);
 }
 const{store,now}=liveStore();assert.equal(store.connection({line:'6',fromStop:'625N',toStop:'632N',readyAt:now}),null);
});
test('failed fetch preserves timestamps and marks the source error instead of inventing data',async()=>{
 const store=new FeedStore({fetcher:async()=>{throw Error('Offline');},tripIndex:{}});
 await store.refreshSubway('gtfs');const s=store.freshness('gtfs');assert.equal(s.stale,true);assert.equal(s.sourceTimestamp,null);assert.equal(s.entities,0);assert.equal(s.error,'Offline');
});

test('arrive-by connections select the latest reachable train before the deadline',()=>{
 const {store,now}=liveStore(),entry=store.entries.get('gtfs');
 const later=structuredClone(entry.message.entity[0]);later.tripUpdate.trip.tripId='later-train';
 later.tripUpdate.stopTimeUpdate[0].departure.time+=300;later.tripUpdate.stopTimeUpdate[1].arrival.time+=300;
 entry.message.entity.push(later);
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now,latestArrival:now+1000000}).tripId,'actual-train');
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now,latestArrival:now+1300000}).tripId,'later-train');
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now,latestArrival:now+100000}),null);
 assert.equal(store.connection({line:'6',fromStop:'632N',toStop:'625N',readyAt:now,latestArrival:now+18*3600000,earliestArrival:now+17*3600000}),null);
});
test('departure boards use actual stop predictions, reject stale/skipped/deleted reports, and preserve directions',()=>{
 const {store,now}=liveStore();
 const stops=[{gtfsId:'nyct:632N',name:'33 St',lat:40.75,lon:-73.98,vehicleMode:'SUBWAY',distance:200,routes:[{shortName:'6',color:'00933C'}]}];
 const rows=store.departures(stops,now);assert.equal(rows.length,1);assert.equal(rows[0].direction,'Uptown');
 assert.equal(rows[0].line,'6');assert.equal(rows[0].predictionReportedAt,new Date(now).toISOString());
 store.entries.get('gtfs').message.entity[0].tripUpdate.stopTimeUpdate[0].scheduleRelationship=1;
 assert.equal(store.departures(stops,now).length,0);
 store.entries.get('gtfs').message.entity[0].tripUpdate.stopTimeUpdate[0].scheduleRelationship=0;
 store.entries.get('gtfs').message.entity[0].isDeleted=true;assert.equal(store.departures(stops,now).length,0);
 store.entries.get('gtfs').message.entity[0].isDeleted=false;store.entries.get('gtfs').sourceTimestamp-=181000;
 assert.equal(store.departures(stops,now).length,0);
});
test('bus departure boards match provider prefixes and SBS without using a subway stop with the same ID',()=>{
 const now=Date.now(),store=new FeedStore({tripIndex:{},busKey:'test-only'});
 store.entries.set('bus',{sourceTimestamp:now,message:{entity:[{tripUpdate:{trip:{routeId:'MTA NYCT_M15+',tripId:'bus'},stopTimeUpdate:[{stopId:'MTA_403058',arrival:{time:Math.floor(now/1000)+180}}]}}]}});
 const stop={gtfsId:'manhattan:403058',name:'Bus stop',lat:40.75,lon:-73.98,vehicleMode:'BUS',distance:80,routes:[{shortName:'M15-SBS'}]};
 assert.equal(store.departures([stop],now)[0].line,'M15-SBS');
 assert.equal(store.departures([{...stop,vehicleMode:'SUBWAY'}],now).length,0);
});

test('subway exploration ranks the nearest station complexes before considering departure times',()=>{
 const now=Date.now(),center={latitude:40.75,longitude:-73.98};
 const stations=[['C1','Grand Central',0.001,'610','6'],['C2','Grand Central',0.0012,'610','7'],
  ['A1','Second',0.002,'2','1'],['A2','Third',0.003,'3','1'],['A3','Fourth',0.004,'4','1'],['A4','Fifth',0.005,'5','7']];
 const structures=stations.map(([id,name,delta,complex,line])=>({gtfs_stop_id:id,stop_name:name,complex_id:complex,daytime_routes:line,
   north_direction_label:line==='7'?'Queens':'Uptown',south_direction_label:line==='7'?'Hudson Yards':'Downtown'}));
 const stops=Object.fromEntries(stations.flatMap(([id,name,delta])=>['N','S'].map(direction=>
   [id+direction,{name,latitude:center.latitude+delta,longitude:center.longitude,parent:id}])));
 const store=new FeedStore({tripIndex:{stops,routes:{6:{route_color:'009952'},7:{route_color:'B933AD'}}},stationStructures:structures});
 const entity=[['6','C1N',120],['6','C1S',180],['7','C2S',150],['7','A4N',60]].map(([line,stopId,inSeconds],i)=>({
   tripUpdate:{trip:{routeId:line,tripId:'trip'+i},stopTimeUpdate:[{stopId,departure:{time:Math.floor(now/1000)+inSeconds}}]}
 }));
 store.entries.set('gtfs',{sourceTimestamp:now,message:{entity}});
 const board=nearbySubwayBoard(store,center,{},now);
 assert.deepEqual(board.stations.map(station=>station.name),['Grand Central','Second','Third','Fourth']);
 assert.deepEqual(board.departures.map(departure=>departure.direction),['Uptown','Hudson Yards','Downtown']);
 assert(board.departures.every(departure=>departure.stationId==='subway-complex:610'));
 assert.equal(board.departures[0].routeColor,'009952');
 assert.deepEqual(nearbySubwayBoard(store,center,{line:'7'},now).stations.map(station=>station.name),['Grand Central','Fifth']);
 assert.equal(nearbySubwayBoard(store,center,{stop:'nyct:C2'},now).departures.length,3);
 assert.equal(nearbySubwayBoard(store,{latitude:40.7549,longitude:-73.98},{},now).stations[0].name,'Fifth');
});
