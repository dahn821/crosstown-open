import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedStore} from '../feeds.mjs';
import {normalize,rank,primaryTransitMode,validateRequest} from '../otp.mjs';
import {subwayOptions,predictionSnapshot,corridorKey} from '../subway-options.mjs';
import {walkingSpeed} from '../walking.mjs';

function fixture({arrivalTime,transfer=false}={}){
 const now=Math.floor(Date.now()/1000)*1000,place=(name,id)=>({name,lat:40.75,lon:-73.99,...id?{stop:{gtfsId:'nyct:'+id}}:{}});
 const origin={id:'origin',name:'Origin',coordinate:{latitude:40.75,longitude:-73.99}},destination={id:'destination',name:'Destination',coordinate:{latitude:40.73,longitude:-74.0}};
 const request=validateRequest({origin,destination,preferences:{modes:['walk','subway']},...arrivalTime?{arrivalTime:new Date(now+arrivalTime*1000).toISOString()}:{}});request.depart=now;
 const store=new FeedStore({tripIndex:{routes:{B:{route_color:'FF6319'},D:{route_color:'FF6319'},F:{route_color:'FF6319'}}}});
 const trip=(line,id,departure,arrival,from='D17S',to='D20S')=>({tripUpdate:{trip:{routeId:line,tripId:id},stopTimeUpdate:[{stopId:from,departure:{time:now/1000+departure}},{stopId:to,arrival:{time:now/1000+arrival}}]}});
 const entities=[trip('B','too-soon',320,650),trip('B','b1',600,900),trip('B','b2',1000,1300),trip('D','d1',700,950),trip('F','f1',800,1100),trip('M','skipped',850,1200),trip('E','other-stop',850,1200,'A32S','A33S')];
 entities[5].tripUpdate.stopTimeUpdate[1].scheduleRelationship=1;
 store.entries.set('gtfs-bdfm',{sourceTimestamp:now,message:{entity:entities}});
 const raw={legs:[{mode:'WALK',duration:300,from:place('Origin'),to:place('Herald Square','D17S')},{mode:'SUBWAY',duration:300,from:place('Herald Square','D17S'),to:place('West 4 St','D20S'),route:{shortName:'B',color:'FF6319'}},{mode:'WALK',duration:120,from:place('West 4 St','D20S'),to:place('Destination')}]};
 if(transfer){store.entries.set('gtfs-g',{sourceTimestamp:now,message:{entity:[trip('G','g1',1100,1400,'D20S','G25S'),trip('G','g2',1600,1850,'D20S','G25S')]}});raw.legs.splice(2,0,{mode:'WALK',duration:60,from:place('West 4 St','D20S'),to:place('Transfer','D20S')},{mode:'SUBWAY',duration:300,from:place('Transfer','D20S'),to:place('Exit','G25S'),route:{shortName:'G'}});}
 const snapshot=predictionSnapshot(store),base=normalize(raw,request,snapshot);
 return {now,raw,request,store:snapshot,base,options:()=>subwayOptions(base?[{raw,route:base}]:[],request,snapshot,{normalize,rank})};
}

test('walking pace is applied as a route-search input and invalid paces are rejected',()=>{
 const {request}=fixture();assert.equal(walkingSpeed(request.preferences),1.65);
 assert.equal(walkingSpeed({...request.preferences,walkingPace:'standard'}),1.35);
 assert.throws(()=>validateRequest({...request,preferences:{walkingPace:'unknown'}}),/walking pace/);
});
test('shared-platform options include only reachable trains that serve both stops',()=>{
 const {options}=fixture(),result=options();assert.equal(result.primaries.length,1);
 assert.deepEqual(result.primaries[0].legs[1].lineOptions.map(option=>option.line),['B','D','F']);
 const trains=Object.values(result.alternativeRoutes).map(route=>route.legs[1].tripId);
 assert(trains.includes('b2'));assert(!trains.includes('too-soon'));assert(!trains.includes('skipped'));assert(!trains.includes('other-stop'));
});
test('a later train has its own complete arrival, waiting and itinerary totals',()=>{
 const {now,options}=fixture(),later=Object.values(options().alternativeRoutes).find(route=>route.legs[1].tripId==='b2');
 assert.equal(Date.parse(later.arrivalTime),now+1420000);assert.equal(later.legs[1].waitingMinutes,700/60);
 assert.equal(later.minutes,1420/60);assert.equal(later.walkingMinutes,7);
});
test('arrive-by options never include a train that misses the deadline',()=>{
 const {now,options}=fixture({arrivalTime:1100}),result=options();
 assert(Object.keys(result.alternativeRoutes).length>0);
 for(const route of Object.values(result.alternativeRoutes))assert(Date.parse(route.arrivalTime)<=now+1100000);
 assert(!Object.values(result.alternativeRoutes).some(route=>route.legs[1].tripId==='b2'));
});
test('choosing a later first train recomputes the onward connection with transfer slack',()=>{
 const {options}=fixture({transfer:true}),routes=Object.values(options().alternativeRoutes),later=routes.find(route=>route.legs[1].tripId==='b2');
 assert(later);assert.equal(later.legs[3].tripId,'g2');
 assert(!routes.some(route=>route.legs[1].tripId==='b2'&&route.legs[3].tripId==='g1'));
});
test('pinned trains cannot silently fall back to another train or to a schedule',()=>{
 const {raw,request,store}=fixture();raw.legs[1].pinnedTripId='gone';request.preferences.requireLiveTransit=false;
 assert.equal(normalize(raw,request,store),null);
});
test('opposite platforms and different access/dock stops remain separate corridors',()=>{
 const {raw}=fixture(),changed=structuredClone(raw);changed.legs[1].from.stop.gtfsId='nyct:D17N';
 assert.notEqual(corridorKey(raw),corridorKey(changed));
});
test('a slower path to the same train cannot replace the quickest complete trip',()=>{
 const {raw,request,store,base}=fixture();
 const slower=structuredClone(raw);
 slower.legs.at(-1).duration+=120;
 const pairs=[{raw,route:base},{raw:slower,route:normalize(slower,request,store)}];
 const result=subwayOptions(pairs,request,store,{normalize,rank,primaryTransitMode});
 assert.equal(result.primaries[0].minutes,base.minutes);
 const sameTrain=Object.values(result.alternativeRoutes).find(route=>route.legs[1].tripId==='b1');
 assert.equal(sameTrain.minutes,base.minutes);
});
test('changing trains on a mixed route preserves the chosen mode comparison',()=>{
 const {now,raw,request,store}=fixture();
 request.preferences.modes.push('bus');
 const from=raw.legs[1].to,to={...from,stop:{gtfsId:'mta:503000'}};
 raw.legs.splice(2,0,{mode:'BUS',duration:275,from,to,route:{shortName:'M1'}});
 store.entries.set('bus',{sourceTimestamp:now,message:{entity:[{tripUpdate:{trip:{routeId:'M1',tripId:'bus'},stopTimeUpdate:[{stopId:'D20S',departure:{time:now/1000+1500}},{stopId:'503000',arrival:{time:now/1000+1775}}]}}]}});
 const base=normalize(raw,request,store);
 const result=subwayOptions([{raw,route:base}],request,store,{normalize,rank,primaryTransitMode});
 assert(result.primaries[0].legs[1].lineOptions.some(option=>option.line==='D'));
 for(const mode of ['subway','bus']){
  const [route]=result.transitCandidates[mode];
  assert(route);
  assert.equal(primaryTransitMode(route),mode);
  for(const id of route.alternativeIds)assert.equal(primaryTransitMode(result.alternativeRoutes[id]),mode);
 }
 assert.deepEqual(result.transitCandidates.bus[0].legs[1].lineOptions.map(option=>option.line),['D']);
});
