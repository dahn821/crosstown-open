import assert from 'node:assert/strict';
import test from 'node:test';
import {createCommunityAPI} from '../community-server.mjs';
import {createTransitousSearch,transitousItinerary} from '../transitous.mjs';
import {defaults} from '../otp.mjs';

const lookup={index:{stops:{},routes:{}},stationStructures:[],busStops:[]};
const request=(path,options)=>new Request('https://example.test'+path,options);

test('the public function validates malformed plans without calling providers', async()=>{
  let calls=0;
  const handle=createCommunityAPI({lookup,restaurants:{restaurants:[]},fetcher:()=>{calls++;throw Error('Unexpected provider call');}});
  for(const body of ['{','null','{}','x'.repeat(20001)]){
    const result=await handle(request('/api/plan',{method:'POST',body}));
    assert.equal(result.status,body.length>20000?413:400);
  }
  assert.equal((await handle(request('/api/setup/bus-time',{method:'POST'}))).status,404);
  assert.equal(calls,0);
});

test('Transitous coordinates and MTA stop IDs decode and unsupported service is excluded',()=>{
  const from={name:'From',lat:40.7,lon:-73.9,stopId:'us-ny-MTA-NYCSubway_R17N'};
  const to={...from,stopId:'us-ny-MTA-NYCSubway_R16N'};
  const leg={mode:'SUBWAY',routeShortName:'Q',from,to,duration:90,legGeometry:{points:'_p~iF~ps|U_ulLnnqC_mqNvxq`@',precision:5}};
  const converted=transitousItinerary({legs:[leg]}).legs[0];
  assert.deepEqual(converted.coordinates[0],{latitude:38.5,longitude:-120.2});
  assert.equal(converted.from.stop.gtfsId,'nyct:R17N');
  assert.equal(converted.to.stop.gtfsId,'nyct:R16N');
  assert.equal(transitousItinerary({legs:[{...leg,cancelled:true}]}),null);
  assert.equal(transitousItinerary({legs:[{...leg,from:{...from,stopId:'external_R17N'}}]}),null);
});

test('Subway loading shares feed checks and skips Bus Time and Citi Bike',async()=>{
  const requested=[];
  const handle=createCommunityAPI({lookup,restaurants:{restaurants:[]},busKey:'test-only',fetcher:async url=>{
    requested.push(String(url));
    return new Response(null,{status:503});
  }});
  await handle(request('/api/health?feeds=0'));
  assert.equal(requested.length,0);
  const [vehicles,stops]=await Promise.all([
    handle(request('/api/vehicles?modes=subway')),
    handle(request('/api/transit?mode=subway&lat=40.75&lon=-73.98'))
  ]);
  assert.equal(vehicles.status,200);
  assert.equal(stops.status,200);
  assert.equal(requested.length,8);
  assert(requested.every(url=>url.includes('api-endpoint.mta.info')));
});

test('the hosted plan can show a real routing result while it checks other modes',async()=>{
  const origin={id:'a',name:'A',coordinate:{latitude:40.75,longitude:-73.98}};
  const destination={id:'b',name:'B',coordinate:{latitude:40.751,longitude:-73.98}};
  const from={name:'A',lat:40.75,lon:-73.98},to={...from,name:'B',lat:40.751};
  const walking={legs:[{mode:'WALK',from,to,duration:120,legGeometry:{points:'_p~iF~ps|U_ulLnnqC',precision:5}}]};
  const bus=Promise.withResolvers();
  const handle=createCommunityAPI({lookup,restaurants:{restaurants:[]},fetcher:async url=>{
    if(url.searchParams.get('transitModes')==='BUS'){
      await bus.promise;
      return Response.json({itineraries:[]});
    }
    return Response.json({direct:[walking]});
  }});
  const body=JSON.stringify({origin,destination,preferences:{modes:['walk','bus'],requireLiveTransit:false}});
  const response=await handle(request('/api/plan',{method:'POST',body,headers:{Accept:'application/x-ndjson'}}));
  assert.equal(response.headers.get('content-type'),'application/x-ndjson');
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  try{
    const first=JSON.parse((await reader.read()).value);
    assert.equal(first.type,'preview');
    assert.equal(first.route.minutes,2);
    assert.equal(first.route.legs[0].mode,'walk');
  }finally{bus.resolve();}
  const complete=JSON.parse((await reader.read()).value);
  assert.equal(complete.type,'result');
  assert.equal(complete.plan.routes[0].minutes,2);
  assert.equal((await reader.read()).done,true);
  const json=await handle(request('/api/plan',{method:'POST',body}));
  assert.equal((await json.json()).routes[0].minutes,2);
});

test('street routes share topology across arrival times and skip impossible walks',async()=>{
  const cache=new Map();
  let calls=0;
  const fetcher=async()=>{calls++;return Response.json({direct:[]});};
  const walk={directOnly:true,direct:['WALK']},place=(latitude,longitude)=>({location:{coordinate:{latitude,longitude}}});
  const origin=place(40.75,-73.98),destination=place(40.755,-73.98);
  const now=Date.now(),preferences=defaults();
  const immediate=createTransitousSearch({},{cache,fetcher});
  const later=createTransitousSearch({},{cache,fetcher,leaveNow:false});
  await immediate.search(origin,destination,walk,preferences,now);
  await later.search(origin,destination,walk,preferences,now+3600000,true);
  assert.equal(calls,1);
  await later.search(origin,destination,walk,{...preferences,walkingPace:'relaxed'},now+3600000,true);
  assert.equal(calls,2);
  const tooFar=await immediate.search(origin,place(40.81,-73.98),walk,preferences,now);
  assert.deepEqual(tooFar,[]);
  assert.equal(calls,2);
});
