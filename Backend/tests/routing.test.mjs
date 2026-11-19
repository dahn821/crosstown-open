import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,validateRequest,normalize,rank,decodePolyline,searchFamilies,compareModes,bestRoutes} from '../otp.mjs';
import {FeedStore} from '../feeds.mjs';
const place=(id,latitude=40.75,longitude=-73.99)=>({id,name:id,neighborhood:'NYC',coordinate:{latitude,longitude},selectable:true});
const request=p=>({...validateRequest({origin:place('A'),destination:place('B',40.78,-73.95),preferences:p}),depart:Date.now()});
const point=(name,id)=>({name,lat:40.75,lon:-73.99,...(id?{stop:{gtfsId:'nyct:'+id}}:{})});
test('mixed transit cannot starve independent subway, bus, or walking searches',()=>{
 const families=searchFamilies(defaults(),true);
 const has=mode=>families.some(f=>f.transit?.transit.length===1&&f.transit.transit[0].mode===mode);
 assert(has('SUBWAY'));assert(has('BUS'));assert(families.some(f=>f.directOnly&&f.direct.length===1&&f.direct[0]==='WALK'));
 assert(!searchFamilies({...defaults(),bikeSource:'ownBike'},true).some(f=>f.transit?.transit.some(t=>t.mode==='BUS')));
 assert(!searchFamilies(defaults(),false).some(f=>f.transit?.transit.some(t=>t.mode==='BUS')));
});
test('mode comparisons retain a valid train even when a bus dominates the overall ranking',()=>{
 const bus={id:'bus',minutes:10,fareCents:300,outdoorMinutes:0,undergroundMinutes:0,walkingMinutes:0,bikingMinutes:0,transfers:0,legs:[{mode:'bus',line:'M1'}]};
 const train={...bus,id:'train',minutes:20,undergroundMinutes:10,legs:[{mode:'subway',line:'6'}]};
 const bike={...bus,id:'bike',minutes:30,fareCents:0,bikingMinutes:30,outdoorMinutes:30,legs:[{mode:'bike'}]};
 const valid=[bus,train,bike],groups=compareModes(valid,defaults());
 assert(!rank(valid,defaults()).some(r=>r.id==='train'));
 assert.equal(groups.subway[0].id,'train');assert.equal(groups.bus[0].id,'bus');assert.equal(groups.bike[0].id,'bike');assert.deepEqual(groups.walk,[]);
});
test('subway and bus comparisons count riding time across transfers, excluding waits',()=>{
 const summary={minutes:40,fareCents:300,outdoorMinutes:10,undergroundMinutes:10,walkingMinutes:4,bikingMinutes:0,transfers:2};
 const ride=(mode,line,minutes,wait=0)=>({mode,line,duration:minutes+wait,waitingMinutes:wait});
 const train={...summary,id:'train',legs:[ride('subway','F',10),ride('subway','A',9),ride('bus','M4',6,14)]};
 const bus={...summary,id:'bus',legs:[ride('bus','M4',10),ride('bus','M2',10),ride('subway','F',7,10)]};
 const bike={...summary,id:'bike',bikingMinutes:30,legs:[{mode:'bike',duration:30,setupMinutes:2},ride('subway','N',3)]};
 const mixed={...summary,id:'mixed',legs:[ride('bus','M2',12),ride('subway','F',12)]};
 const groups=compareModes([train,bus,bike,mixed],defaults());
 assert.deepEqual(groups.subway.map(route=>route.id),['train']);
 assert.deepEqual(groups.bus.map(route=>route.id),['bus']);
 assert.deepEqual(groups.bike.map(route=>route.id),['bike']);
});
test('Best Fastest compares all modes and Less outside ranks only bike-free transit',()=>{
 const summary={fareCents:300,undergroundMinutes:5,walkingMinutes:3,bikingMinutes:0,transfers:0};
 const bike={...summary,id:'bike',minutes:8,outdoorMinutes:8,bikingMinutes:6,legs:[{mode:'bike',duration:6},{mode:'walk',duration:2}]};
 const bikeTrain={...summary,id:'bike-train',minutes:23,outdoorMinutes:4,bikingMinutes:3,legs:[{mode:'bike',duration:3},{mode:'subway',line:'N',duration:20}]};
 const walk={...summary,id:'walk',minutes:15,outdoorMinutes:15,walkingMinutes:15,legs:[{mode:'walk',duration:15}]};
 const bus={...summary,id:'bus',minutes:16,outdoorMinutes:9,legs:[{mode:'bus',line:'M2',duration:13}]};
 const subway={...summary,id:'subway',minutes:27,outdoorMinutes:5,legs:[{mode:'subway',line:'A',duration:24}]};
 const mix={...summary,id:'mix',minutes:22,outdoorMinutes:5,legs:[{mode:'subway',line:'F',duration:10},{mode:'bus',line:'M1',duration:9}]};
 const candidates=[bus,bikeTrain,walk,mix,subway,bike];
 assert.equal(bestRoutes(candidates,defaults())[0].id,'bike');
 const sheltered={...defaults(),priority:'sheltered'};
 const best=bestRoutes(candidates,sheltered);
 assert.equal(best[0].id,'mix');
 assert(best.every(route=>!['walk','bike','bike-train'].includes(route.id)));
 assert.deepEqual(bestRoutes([walk,bike],sheltered),[]);
 assert(compareModes(candidates,sheltered).bike.length);
});
test('a legitimate zero custom score beats a positive score; only all-zero weights fall back to time',()=>{
 const bike={id:'free',minutes:40,fareCents:0,outdoorMinutes:40,undergroundMinutes:0,walkingMinutes:0,bikingMinutes:40,transfers:0,legs:[{mode:'bike'}]};
 const train={...bike,id:'paid',minutes:20,fareCents:300,outdoorMinutes:5,undergroundMinutes:15,bikingMinutes:0,walkingMinutes:5,legs:[{mode:'subway',line:'6'}]};
 const preferences={...defaults(),priority:'custom',timeWeight:0,costWeight:25,outsideWeight:0,undergroundWeight:0};
 assert.equal(rank([bike,train],preferences)[0].id,'free');
 assert.equal(rank([bike,train],{...preferences,costWeight:0})[0].id,'paid');
});
test('coordinates and hard limits are validated at the API boundary',()=>{
 assert.throws(()=>request({maxFareCents:-1}));assert.throws(()=>request({maxWalkingMinutes:Infinity}));
 assert.throws(()=>validateRequest({origin:place('A',52,0),destination:place('B')}));
 assert.throws(()=>validateRequest({origin:place('A'),destination:place('A')}));
});
test('live-only never relabels an unreported train as live',()=>{
 const r=request({}),start=r.depart+120000,end=start+600000;
 const raw={legs:[{mode:'SUBWAY',duration:600,from:point('33 St','632N'),to:point('96 St','625N'),route:{shortName:'6'},start:{scheduledTime:new Date(start).toISOString()},end:{scheduledTime:new Date(end).toISOString()}}]};
 const store={bikeStations:()=>[],connection:()=>null,busKey:''};
 assert.equal(normalize(raw,r,store),null);r.preferences.requireLiveTransit=false;
 const result=normalize(raw,r,store);assert.equal(result.dataQuality,'scheduled');assert.equal(result.legs[0].realtime,false);
 assert.equal(result.outdoorMinutes,0);assert.equal(result.fareCents,300);
});
test('retiming uses the reported departure and arrival, including actual waiting',()=>{
 const r=request({}),departure=r.depart+180000,arrival=r.depart+780000;
 const raw={legs:[{mode:'SUBWAY',duration:50,from:point('33 St','632N'),to:point('96 St','625N'),route:{shortName:'6'}}]};
 const result=normalize(raw,r,{bikeStations:()=>[],connection:()=>({departure,arrival})});
 assert.equal(result.minutes,13);assert.equal(result.legs[0].waitingMinutes,3);assert.equal(result.dataQuality,'live');
 r.preferences.maxFareCents=200;assert.equal(normalize(raw,r,{bikeStations:()=>[],connection:()=>({departure,arrival})}),null);
});
test('live rental routes require classic bikes, an operating pickup, and a fresh return dock',()=>{
 const r=request({maxBikingMinutes:90}),now=Date.now();let pickup={id:'a',classicBikes:2,docks:5,isRenting:true,isReturning:true,reportedAt:now},dropoff={...pickup,id:'b'};
 const raw={legs:[{mode:'BICYCLE',rentedBike:true,duration:2760,from:{...point('Pickup'),vehicleRentalStation:{stationId:'citibike:a'}},to:{...point('Return'),vehicleRentalStation:{stationId:'citibike:b'}}}]};
 const store={bikeStations:()=>[pickup,dropoff],status:()=>({bikes:{stale:false}})};
 assert.equal(normalize(raw,r,store).fareCents,27);r.preferences.citiBikeMember=false;assert.equal(normalize(raw,r,store).fareCents,1155);
 pickup.classicBikes=0;assert.equal(normalize(raw,r,store),null);pickup.classicBikes=2;dropoff.docks=0;assert.equal(normalize(raw,r,store),null);dropoff.docks=5;dropoff.reportedAt-=301000;assert.equal(normalize(raw,r,store),null);
});
test('street endpoints at a bike handoff use the connecting dock names',()=>{
 const now=Date.now(),pickup={id:'a',classicBikes:3,docks:6,isRenting:true,isReturning:true,reportedAt:now},dropoff={...pickup,id:'b'};
 const dock=(name,id)=>({...point(name),vehicleRentalStation:{stationId:'citibike:'+id}});
 const raw={legs:[{mode:'WALK',from:point('START'),to:point('END'),duration:40},
  {mode:'BICYCLE',rentedBike:true,from:dock('Pickup Dock','a'),to:dock('Return Dock','b'),duration:250},
  {mode:'WALK',from:point('START'),to:point('END'),duration:45}]};
 const result=normalize(raw,request({}),{bikeStations:()=>[pickup,dropoff],status:()=>({bikes:{stale:false}})});
 assert.equal(result.legs[0].instruction,'Walk to Pickup Dock');
 assert.equal(result.legs[2].from.name,'Return Dock');
});
test('personal bikes avoid rental fees and cannot silently board buses',()=>{
 const r=request({bikeSource:'ownBike'}),raw={legs:[{mode:'BICYCLE',duration:600,from:point('A'),to:point('B')}]};
 assert.equal(normalize(raw,r,{bikeStations:()=>[]}).fareCents,0);
 raw.legs[0].mode='BUS';assert.equal(normalize(raw,r,{bikeStations:()=>[]}),null);
});
test('preference ranking preserves concrete time, price and exposure tradeoffs',()=>{
 const a={id:'fast',minutes:20,fareCents:300,outdoorMinutes:12,undergroundMinutes:8,walkingMinutes:4,bikingMinutes:8,transfers:0,legs:[{mode:'bike'},{mode:'subway',line:'6'}]},b={...a,id:'cheap',minutes:35,fareCents:0,outdoorMinutes:35,undergroundMinutes:0,bikingMinutes:35,walkingMinutes:0,legs:[{mode:'bike'}]},c={...a,id:'shelter',minutes:45,outdoorMinutes:3,undergroundMinutes:0,bikingMinutes:0,walkingMinutes:2,legs:[{mode:'bus',line:'M4'}]};
 for(const [priority,winner]of [['fastest','fast'],['cost','cheap'],['aboveGround','cheap'],['sheltered','shelter']])assert.equal(rank(structuredClone([a,b,c]),{...defaults(),priority})[0].id,winner);
});
test('real route geometry is decoded without schematic straight-line substitutes',()=>{
 const points=decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');assert.deepEqual(points[0],{latitude:38.5,longitude:-120.2});assert.equal(points.length,3);
});

test('a live bus itinerary preserves its prediction times and identifies its data as bus predictions',()=>{
 const r=request({}),departure=r.depart+120000,arrival=departure+600000;
 const raw={legs:[{mode:'BUS',duration:50,from:point('Pickup','403058'),to:point('Dropoff','403059'),route:{shortName:'M15-SBS'}}]};
 const result=normalize(raw,r,{bikeStations:()=>[],connection:()=>({departure,arrival})});
 assert.equal(result.dataSummary,'Live bus predictions');assert.equal(result.legs[0].realtime,true);
 assert.equal(result.legs[0].departureTime,new Date(departure).toISOString());
 assert.equal(result.legs[0].arrivalTime,new Date(arrival).toISOString());
 assert.equal(result.minutes,12);
});

test('departure and arrival inputs are exclusive, bounded, and reject invalid arrival dates',()=>{
 const base={origin:place('A'),destination:place('B',40.78,-73.95)},time=new Date(Date.now()+3600000).toISOString();
 assert.equal(validateRequest({...base,arrivalTime:time}).arriveBy,Date.parse(time));
 assert.throws(()=>validateRequest({...base,departureTime:time,arrivalTime:time}),/either/);
 assert.throws(()=>validateRequest({...base,arrivalTime:'invalid'}));
 assert.throws(()=>validateRequest({...base,arrivalTime:new Date(Date.now()+15*86400000).toISOString()}));
});
test('arrive-by retiming includes access, boarding slack, egress, and rejects departures in the past',()=>{
 const r=request({}),deadline=r.depart+30*60000;r.arriveBy=deadline;
 const departure=r.depart+15*60000,arrival=r.depart+25*60000;
 const raw={legs:[{mode:'WALK',duration:300,from:point('Start'),to:point('Station')},{mode:'SUBWAY',duration:600,from:point('33 St','632N'),to:point('96 St','625N'),route:{shortName:'6'}},{mode:'WALK',duration:180,from:point('Station'),to:point('End')}]};
 const store={bikeStations:()=>[],connection:({readyAt,latestArrival=Infinity})=>departure>=readyAt&&arrival<=latestArrival?{departure,arrival}:null};
 const result=normalize(raw,r,store);
 assert.equal(Date.parse(result.departureTime),departure-345000);
 assert.equal(Date.parse(result.arrivalTime),arrival+180000);assert(Date.parse(result.arrivalTime)<=deadline);
 r.arriveBy=arrival+120000;assert.equal(normalize(raw,r,store),null);
 r.arriveBy=deadline;r.depart=departure-300000;assert.equal(normalize(raw,r,store),null);
});
test('arrive-by retains the backward-selected transfer instead of switching to a later missed connection',()=>{
 const r=request({});r.arriveBy=r.depart+40*60000;
 const first={departure:r.depart+10*60000,arrival:r.depart+20*60000},second={departure:r.depart+24*60000,arrival:r.depart+35*60000};
 const raw={legs:[{mode:'SUBWAY',duration:600,from:point('A','A'),to:point('B','B'),route:{shortName:'6'}},{mode:'WALK',duration:60,from:point('B'),to:point('C')},{mode:'SUBWAY',duration:660,from:point('C','C'),to:point('D','D'),route:{shortName:'4'}}]};
 const store={bikeStations:()=>[],connection:({line,latestArrival=Infinity})=>{const c=line==='6'?first:second;return c.arrival<=latestArrival?c:null;}};
 const result=normalize(raw,r,store);assert(result);assert.equal(result.legs[0].departureTime,new Date(first.departure).toISOString());
 assert.equal(result.legs[2].departureTime,new Date(second.departure).toISOString());
 assert(Date.parse(result.arrivalTime)<=r.arriveBy);
});
test('duplicate identities cannot hide a faster connection and priority metrics use exact ordering',()=>{
 const base={id:'same',minutes:20,fareCents:300,outdoorMinutes:10,undergroundMinutes:10,walkingMinutes:4,bikingMinutes:0,transfers:0,legs:[{mode:'subway',line:'6'}]};
 assert.equal(rank([base,{...base,minutes:30}],defaults())[0].minutes,20);
 const a={...base,id:'a',outdoorMinutes:10.001,minutes:10,legs:[{mode:'subway',line:'6'}]},b={...base,id:'b',outdoorMinutes:10,minutes:40,legs:[{mode:'bus',line:'M4'}]};
 assert.equal(rank([a,b],{...defaults(),priority:'sheltered'})[0].id,'b');
});

test('tomorrow arrive-by trips cannot borrow a live train from today',()=>{
 const r=request({requireLiveTransit:false});r.arriveBy=r.depart+18*3600000;
 const store=new FeedStore({tripIndex:{}});
 store.entries.set('gtfs',{sourceTimestamp:r.depart,message:{entity:[{tripUpdate:{trip:{routeId:'6',tripId:'current'},stopTimeUpdate:[{stopId:'632N',departure:{time:Math.floor(r.depart/1000)+120}},{stopId:'625N',arrival:{time:Math.floor(r.depart/1000)+900}}]}}]}});
 const departure=r.arriveBy-11*60000,arrival=r.arriveBy-60000;
 const raw={legs:[{mode:'SUBWAY',duration:600,from:point('33 St','632N'),to:point('96 St','625N'),route:{shortName:'6'},start:{scheduledTime:new Date(departure).toISOString()},end:{scheduledTime:new Date(arrival).toISOString()}}]};
 const result=normalize(raw,r,store);assert(result);assert.equal(result.dataQuality,'scheduled');
 assert.equal(result.arrivalTime,new Date(arrival).toISOString());assert.equal(result.legs[0].realtime,false);
});
