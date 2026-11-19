import assert from 'node:assert/strict';
import test from 'node:test';
import {createCommunityAPI} from '../community-server.mjs';
import {transitousItinerary} from '../transitous.mjs';

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
