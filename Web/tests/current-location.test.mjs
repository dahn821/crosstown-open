import test from 'node:test';
import assert from 'node:assert/strict';
import {CURRENT_LOCATION_ID,createCurrentLocationLookup,createLocationSource} from '../dist/current-location.mjs';

const fix=(overrides={})=>({timestamp:Date.now(),coords:{latitude:40.78,longitude:-73.96,accuracy:25},...overrides});
function sensor(){
 const calls=[];
 return {calls,getCurrentPosition(success,failure,options){calls.push({success,failure,options});}};
}

test('concurrent route requests share one acquisition and the fast fix beats slow GPS',async()=>{
 const events=[],geolocation=sensor();
 const lookup=createCurrentLocationLookup({geolocation,onUpdate:update=>events.push(update)});
 const first=lookup.request(),second=lookup.request();
 assert.equal(first,second);assert.equal(geolocation.calls.length,2);
 assert.equal(geolocation.calls[0].options.enableHighAccuracy,false);
 assert.equal(geolocation.calls[1].options.enableHighAccuracy,true);
 geolocation.calls[0].success(fix());
 assert.equal(await first,true);
 assert.equal(events.at(-1).place.id,CURRENT_LOCATION_ID);
 assert.deepEqual(events.at(-1).place.coordinate,{latitude:40.78,longitude:-73.96});
 const count=events.length;geolocation.calls[1].success(fix({coords:{latitude:40.79,longitude:-73.95,accuracy:5}}));
 assert.equal(events.length,count,'A late GPS completion must not trigger a second search.');
});

test('a launch-time warmup supplies the later app without another wait or spinner',async()=>{
 const geolocation=sensor(),source=createLocationSource({geolocation}),warmup=source.prefetch();
 geolocation.calls[0].success(fix());await warmup;
 const events=[],lookup=createCurrentLocationLookup({source,onUpdate:update=>events.push(update)});
 assert.equal(await lookup.request(),true);assert.equal(geolocation.calls.length,2);
 assert.deepEqual(events.map(e=>e.status),['ready']);
});

test('a lookup attaches to an in-progress warmup rather than restarting location hardware',async()=>{
 const geolocation=sensor(),source=createLocationSource({geolocation}),warmup=source.prefetch();
 const lookup=createCurrentLocationLookup({source,onUpdate:()=>{}}),pending=lookup.request();
 assert.equal(geolocation.calls.length,2);geolocation.calls[1].success(fix());
 assert.equal(await pending,true);await warmup;
});

test('a manually selected address cannot be replaced by a late warmed location',async()=>{
 const events=[],geolocation=sensor(),source=createLocationSource({geolocation});
 const lookup=createCurrentLocationLookup({source,onUpdate:update=>events.push(update)});
 const pending=lookup.request();lookup.cancel();geolocation.calls[0].success(fix());
 assert.equal(await pending,false);assert.deepEqual(events.map(event=>event.status),['loading']);
 assert(source.cached(),'The sensor result can be ready for a later explicit current-location selection.');
});

test('cached fixes expire after 30 seconds and cannot be reused indefinitely',async()=>{
 let now=100000;const geolocation=sensor(),source=createLocationSource({geolocation,now:()=>now});
 const first=source.get();geolocation.calls[0].success(fix({timestamp:now}));await first;
 now+=29000;assert(source.cached());await source.get();assert.equal(geolocation.calls.length,2);
 now+=2000;assert.equal(source.cached(),null);const next=source.get();assert.equal(geolocation.calls.length,4);
 geolocation.calls[2].success(fix({timestamp:now}));await next;
});

test('a coarse first result waits for usable precision without losing the fast path',async()=>{
 const events=[],geolocation=sensor();
 const lookup=createCurrentLocationLookup({geolocation,onUpdate:update=>events.push(update)}),pending=lookup.request();
 geolocation.calls[0].success(fix({coords:{latitude:40.78,longitude:-73.96,accuracy:1500}}));
 assert.equal(events.at(-1).status,'loading');geolocation.calls[1].success(fix());
 assert.equal(await pending,true);assert.equal(events.at(-1).status,'ready');
});

test('permission denial and insecure hosting never invent an origin',async()=>{
 for(const options of [{geolocation:{getCurrentPosition(success,failure){failure({code:1});}}},{secure:false}]){
  const events=[],lookup=createCurrentLocationLookup({...options,onUpdate:update=>events.push(update)});
  assert.equal(await lookup.request(),false);assert.equal(events.at(-1).status,'error');
  assert.equal(events.at(-1).place,undefined);assert.match(events.at(-1).message,/choose a start/i);
 }
});

test('invalid, stale, future and overly broad fixes cannot be sent to routing',async()=>{
 for(const position of [fix({coords:{latitude:NaN,longitude:-73.96,accuracy:5}}),fix({timestamp:Date.now()-60000}),fix({timestamp:Date.now()+60000}),fix({coords:{latitude:40.78,longitude:-73.96,accuracy:2000}})]){
  const events=[],lookup=createCurrentLocationLookup({geolocation:{getCurrentPosition(success){success(position);}},onUpdate:update=>events.push(update)});
  assert.equal(await lookup.request(),false);assert.equal(events.at(-1).status,'error');
 }
});

test('an unavailable quick fix does not abort a still-running GPS fix',async()=>{
 const geolocation=sensor(),lookup=createCurrentLocationLookup({geolocation,onUpdate:()=>{}}),pending=lookup.request();
 geolocation.calls[0].failure({code:2});geolocation.calls[1].success(fix());assert.equal(await pending,true);
});
