import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedStore} from '../feeds.mjs';
import {vehicleQuery,vehicleSnapshot,vehicleDirection} from '../vehicles.mjs';
import {vehicleTrip,vehicleTripQuery} from '../vehicle-trip.mjs';
import {trackingId} from '../trip-reports.mjs';
import {busTripSegments} from '../bus-trip-shapes.mjs';
import {nearbySubwayBoard} from '../subway-stations.mjs';
const now=Date.now(),seconds=Math.floor(now/1000);
test('direction arrows follow reported GPS or actual stop order, including reverse trips and terminals',()=>{
 const stops={a:{name:'A',latitude:40.7,longitude:-74},b:{name:'B',latitude:40.71,longitude:-74},c:{name:'C',latitude:40.71,longitude:-73.99}};
 const update=ids=>({stopTimeUpdate:ids.map(stopId=>({stopId}))});
 assert.equal(vehicleDirection({position:{bearing:270}},null).bearing,270);
 assert.equal(vehicleDirection({stopId:'a'},update(['a','b']),stops).bearing,0);
 assert.equal(vehicleDirection({stopId:'b'},update(['b','a']),stops).bearing,180);
 assert(Math.abs(vehicleDirection({stopId:'b'},update(['b','c']),stops).bearing-90)<.01);
 const terminal=vehicleDirection({stopId:'a'},update(['b','a']),stops);
 assert.equal(terminal.bearing,180);assert.equal(terminal.bearingSource,'stop-sequence');
 assert.equal(vehicleDirection({stopId:'a'},update(['a']),stops).bearing,null);
 assert.equal(vehicleDirection({position:{}},null).bearing,null);
 assert.equal(vehicleDirection({position:{bearing:400}},null).bearing,null);
});
test('train headings can match an unambiguous same-trip update without a vehicle start date',()=>{
 const s=store();s.tripIndex.stops.next={name:'Next',latitude:40.76,longitude:-73.982};
 s.entries.get('gtfs').message.entity.push({tripUpdate:{trip:{tripId:'train-trip',routeId:'6',startDate:'20261117'},stopTimeUpdate:[{stopId:'632N'},{stopId:'next'}]}});
 const train=vehicleSnapshot(s,{now}).vehicles.find(v=>v.mode==='subway');
 assert.equal(train.bearing,0);assert.equal(train.bearingSource,'stop-sequence');assert.match(train.directionLabel,/Toward Next/);
});
function store(){
 const result=new FeedStore({busKey:'test-only',tripIndex:{stops:{'632N':{name:'33 St',latitude:40.746,longitude:-73.982}},routes:{6:{route_color:'00933C'}}}});
 result.entries.set('busVehicles',{sourceTimestamp:now,message:{entity:[{id:'bus',vehicle:{trip:{tripId:'bus-trip',routeId:'MTA NYCT_M34+'},vehicle:{id:'123'},timestamp:seconds,position:{latitude:40.75,longitude:-73.99,bearing:90}}}]}});
 result.entries.set('gtfs',{sourceTimestamp:now,message:{entity:[{id:'train',vehicle:{trip:{tripId:'train-trip',routeId:'6'},timestamp:seconds,currentStatus:2,stopId:'632N'}}]}});
 return result;
}
test('bus markers preserve measured GPS while subway markers explicitly use station reports',()=>{
 const result=vehicleSnapshot(store(),{now});assert.equal(result.vehicles.length,2);
 const bus=result.vehicles.find(v=>v.mode==='bus'),train=result.vehicles.find(v=>v.mode==='subway');
 assert.deepEqual(bus.coordinate,{latitude:40.75,longitude:-73.99});assert.equal(bus.accuracy,'gps');assert.equal(bus.line,'M34-SBS');assert.equal(bus.bearing,90);
 assert.deepEqual(train.coordinate,{latitude:40.746,longitude:-73.982});assert.equal(train.accuracy,'reported-stop');assert.match(train.status,/Reported at 33 St/);
 assert.equal(train.reportedAtSeconds,seconds);assert.equal(train.routeColor,'00933C');
});
test('trains in transit point to their next station without fabricated between-station coordinates',()=>{
 const s=store();s.entries.get('gtfs').message.entity[0].vehicle.currentStatus=1;
 const train=vehicleSnapshot(s,{now}).vehicles.find(v=>v.mode==='subway');
 assert.equal(train.accuracy,'next-stop');assert.equal(train.status,'Heading toward 33 St');assert.deepEqual(train.coordinate,{latitude:40.746,longitude:-73.982});
});
test('fresh feed headers cannot make old, future-dated, deleted, canceled, or invalid GPS reports live',()=>{
 for(const mutate of [v=>v.timestamp=seconds-100,v=>v.timestamp=seconds+60,v=>v.position.latitude=0,v=>delete v.position,v=>v.trip.scheduleRelationship=3]){
  const s=store();mutate(s.entries.get('busVehicles').message.entity[0].vehicle);
  assert(!vehicleSnapshot(s,{now}).vehicles.some(v=>v.mode==='bus'));
 }
 const s=store();s.entries.get('gtfs').message.entity[0].isDeleted=true;
 assert(!vehicleSnapshot(s,{now}).vehicles.some(v=>v.mode==='subway'));
});
test('unknown station IDs and stale source feeds never become location markers',()=>{
 const s=store();s.entries.get('gtfs').message.entity[0].vehicle.stopId='unknown';
 assert(!vehicleSnapshot(s,{now}).vehicles.some(v=>v.mode==='subway'));
 s.entries.get('busVehicles').sourceTimestamp-=181000;assert.equal(vehicleSnapshot(s,{now}).vehicles.length,0);
});
test('viewport, modes, and SBS-aware route filters narrow actual vehicle reports',()=>{
 const s=store();assert.equal(vehicleSnapshot(s,{now,modes:['bus'],lines:['M34-SBS']}).vehicles.length,1);
 assert.equal(vehicleSnapshot(s,{now,modes:['bus'],lines:['M34']}).vehicles.length,0);
 assert.equal(vehicleSnapshot(s,{now,bounds:[-74.1,40.8,-73.9,40.9]}).vehicles.length,0);
});
test('invalid viewport and route inputs fail before accessing providers',()=>{
 for(const query of ['bbox=bad','bbox=-74,41,-75,40','bbox=-74,40,500,41','modes=spaceship','lines=%3Cscript%3E'])assert.throws(()=>vehicleQuery(new URLSearchParams(query)));
 assert.deepEqual(vehicleQuery(new URLSearchParams('modes=bus&lines=M34-SBS')).lines,['M34-SBS']);
});
test('a canceled trip update suppresses a matching vehicle report',()=>{
 const s=store();s.entries.get('gtfs').message.entity.push({tripUpdate:{trip:{tripId:'train-trip',routeId:'6',scheduleRelationship:3}}});
 assert(!vehicleSnapshot(s,{now}).vehicles.some(v=>v.mode==='subway'));
});
test('optional subway network uses active directional calls and excludes skipped stations',()=>{
 const stops={'632N':{name:'33 St',latitude:40.746,longitude:-73.982},
  nextN:{name:'Next',latitude:40.760,longitude:-73.982},skippedN:{name:'Skipped',latitude:40.750,longitude:-73.982}};
 const s=new FeedStore({tripIndex:{stops,routes:{6:{route_color:'00933C'}}},
  subwayShapeData:{'6..N01R':[[40.746,-73.982],[40.752,-73.98],[40.760,-73.982]]}});
 const calls=[{stopId:'632N',arrival:{time:seconds+60}},{stopId:'skippedN',scheduleRelationship:1},{stopId:'nextN',arrival:{time:seconds+180}}];
 s.entries.set('gtfs',{sourceTimestamp:now,message:{entity:[{tripUpdate:{trip:{tripId:'live_6..N',routeId:'6'},stopTimeUpdate:calls}}]}});
 const options=vehicleQuery(new URLSearchParams('modes=subway&network=1&lines=6'));
 const network=vehicleSnapshot(s,{...options,now}).network;
 assert.deepEqual(network.stations.map(stop=>stop.name),['33 St','Next']);
 assert.deepEqual(network.segments,[{line:'6',color:'00933C',points:[[40.746,-73.982],[40.752,-73.98],[40.76,-73.982]]}]);
 assert.equal(vehicleSnapshot(s,{now}).network,undefined);
});
test('unmatched live subway detours retain the stops without drawing a straight rail segment',()=>{
 const stops={aN:{name:'A',latitude:40.74,longitude:-73.98},bN:{name:'B',latitude:40.76,longitude:-73.96}};
 const s=new FeedStore({tripIndex:{stops},subwayShapeData:{'6..N01R':[[40.74,-73.98],[40.76,-73.98]]}});
 const calls=[{stopId:'aN',arrival:{time:seconds+60}},{stopId:'bN',arrival:{time:seconds+150}}];
 s.entries.set('gtfs',{sourceTimestamp:now,message:{entity:[{tripUpdate:{trip:{tripId:'test_6..N01R',routeId:'6'},stopTimeUpdate:calls}}]}});
 const {network}=vehicleSnapshot(s,{modes:['subway'],network:true,now});
 assert.equal(network.stations.length,2);
 assert.equal(network.segments.length,0);
 assert.equal(network.unmatchedSegments,1);
});
test('vehicle provider failures never expose the private credential in source status',async()=>{
 const key='private-test-value',s=new FeedStore({tripIndex:{},busKey:key,fetcher:async url=>{throw Error('Request failed: '+url);}});
 await s.refreshBusVehicles();
 assert.equal(s.status().busVehicles.error,'Bus GPS positions could not be refreshed.');
 assert(!JSON.stringify(s.status()).includes(key));
});
test('live stop observations drive the same moving train and countdown across endpoints',async()=>{
 const stops={oldN:{name:'Old station',latitude:40.74,longitude:-73.982},
  '632N':{name:'33 St',latitude:40.746,longitude:-73.982},
  skipN:{name:'Skipped station',latitude:40.75,longitude:-73.981},
  nextN:{name:'Next station',latitude:40.76,longitude:-73.982}};
 const s=new FeedStore({tripIndex:{stops},subwayShapeData:{'6..N01R':[[40.74,-73.982],[40.746,-73.982],[40.751,-73.981],[40.76,-73.982]]}});
 const trip={tripId:'track_6..N01R',routeId:'6',startDate:'20261119'};
 const entity={tripUpdate:{trip,stopTimeUpdate:[
  {stopId:'oldN',departure:{time:seconds-10}},
  {stopId:'632N',arrival:{time:seconds-2},departure:{time:seconds+65}},
  {stopId:'skipN',arrival:{time:seconds+120},scheduleRelationship:1},
  {stopId:'nextN',arrival:{time:seconds+180}}
 ]}};
 const position={vehicle:{trip,timestamp:seconds-30,stopId:'632N',currentStatus:1}};
 s.entries.set('gtfs',{sourceTimestamp:now,message:{entity:[position,entity]}});
 const board=nearbySubwayBoard(s,stops['632N'],{stop:'632N'},now).departures;
 const [marker]=vehicleSnapshot(s,{now}).vehicles;
 assert.equal(marker.trackingId,board[0].trackingId);
 assert.equal(marker.accuracy,'interpolated');
 assert.equal(marker.nextStop.stopId,'632N');
 assert.equal(marker.motion.fromStopId,'oldN');
 assert(marker.coordinate.latitude>40.74&&marker.coordinate.latitude<40.746);
 assert.equal(marker.nextStop.arrivalTime,board[0].arrivalTime);
 assert.notEqual(marker.nextStop.arrivalTime,new Date((seconds-2)*1000).toISOString());
 assert.equal(board[0].estimateSource,'vehicle-reports');
 assert(vehicleSnapshot(s,{now:now+5000}).vehicles[0].coordinate.latitude>marker.coordinate.latitude);
 const query=vehicleTripQuery(new URLSearchParams({id:marker.trackingId}));
 const details=await vehicleTrip(s,query,now);
 assert.equal(details.status,'live');
 assert.deepEqual(details.stops.map(stop=>stop.name),['33 St','Next station']);
 assert.equal(details.stops[0].arrivalTime,board[0].arrivalTime);
 assert.equal(details.position.accuracy,'interpolated');
 assert.deepEqual(details.segments[1],[[40.746,-73.982],[40.751,-73.981],[40.76,-73.982]]);
 assert.deepEqual(details.segments[0][0],[marker.coordinate.latitude,marker.coordinate.longitude]);
 assert.equal(vehicleSnapshot(s,{now:now+91000}).vehicles.length,0);
 s.entries.set('gtfs',{sourceTimestamp:now,message:{entity:[entity]}});
 assert.equal(vehicleSnapshot(s,{now}).vehicles.length,0);
 assert.equal(nearbySubwayBoard(s,stops['632N'],{stop:'632N'},now).departures.length,0);
 entity.tripUpdate.trip.scheduleRelationship=3;
 assert.equal((await vehicleTrip(s,query,now)).status,'changed');
});
test('vehicle tracking rejects unsupported feeds and preserves the trip service date',async()=>{
 const parse=id=>vehicleTripQuery(new URLSearchParams({id}));
 assert.throws(()=>parse('bad'),{status:400});
 assert.throws(()=>parse(trackingId('unknown',{tripId:'ok'})),{status:400});
 const s=store(),entry=s.entries.get('gtfs');
 entry.message.entity.push({tripUpdate:{trip:{tripId:'train-trip',routeId:'6',startDate:'20261119'},
  stopTimeUpdate:[{stopId:'632N',arrival:{time:seconds+60}}]}});
 const wrongDay=trackingId('gtfs',{tripId:'train-trip',startDate:'20261120'});
 assert.deepEqual(await vehicleTrip(s,parse(wrongDay),now),{status:'unavailable'});
});
test('the remaining bus path clips the route shape at GPS and follows turns in upcoming stop order',()=>{
 const a=[40.74,-73.99],b=[40.746,-73.99],turn=[40.746,-73.98],c=[40.75,-73.98];
 const data={
  stops:new Map([['2',{lat:b[0],lon:b[1]}],['3',{lat:c[0],lon:c[1]}]]),
  groups:[{id:'0',points:[[a,b,turn,c]]}],points:[]
 };
 const gps={latitude:40.744,longitude:-73.99};
 const segments=busTripSegments(data,0,[{stopId:'2'},{stopId:'3'}],gps);
 assert.equal(segments.length,2);
 assert(Math.abs(segments[0][0][0]-gps.latitude)<0.000001);
 assert.deepEqual(segments[1],[b,turn,c]);
});
