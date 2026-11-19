import assert from 'node:assert/strict';
import test from 'node:test';
import {FeedStore} from '../feeds.mjs';
import {ridePrediction,rideQuery} from '../ride.mjs';

const now=Date.now();
const params=()=>new URLSearchParams({mode:'bus',line:'M34-SBS',trip:'current-bus',from:'100',to:'103',departure:new Date(now+60000).toISOString()});
const store=new FeedStore({tripIndex:{}});
const call=(stopId,minutes,scheduleRelationship=0)=>({stopId,scheduleRelationship,arrival:{time:Math.floor(now/1000)+minutes*60}});
const update=(calls,options={})=>({tripUpdate:{trip:{routeId:'MTA NYCT_M34+',tripId:'current-bus',...options},stopTimeUpdate:calls}});
const put=(entities,sourceTimestamp=now)=>store.entries.set('bus',{sourceTimestamp,message:{entity:entities}});

test('ride predictions match the exact trip and boarding and alighting stops',()=>{
  put([update([call('MTA_100',1),call('MTA_103',7)]),update([call('100',2),call('103',3)],{tripId:'different-bus'})]);
  const result=ridePrediction(store,rideQuery(params()));
  assert.equal(result.status,'live');
  assert.equal(Date.parse(result.arrivalTime)-Date.parse(result.departureTime),6*60000);
});

test('an arrival stays live after the provider removes the boarding call',()=>{
  put([update([call('103',7)])]);
  const result=ridePrediction(store,rideQuery(params()));
  assert.equal(result.status,'live');
  assert.equal(result.departureTime,null);
  assert(result.arrivalTime);
});

test('missing, skipped and stale reports receive distinct statuses',()=>{
  const query=rideQuery(params());
  put([update([call('100',1),call('103',7,1)])]);
  assert.equal(ridePrediction(store,query).status,'changed');
  put([update([call('100',1),call('103',7)])],now-240000);
  assert.equal(ridePrediction(store,query).status,'unavailable');
  assert.throws(()=>rideQuery(new URLSearchParams({mode:'subway',line:'no such line'})),error=>error.status===400);
});
