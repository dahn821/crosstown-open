import test from 'node:test';
import assert from 'node:assert/strict';
import {restaurantPlaces,searchRestaurantPlaces,photonPlaces,mergePlaces,createPlaceSearch} from '../places.mjs';

const rows=[
  {camis:'50164736',dba:'CHADA',boro:'Manhattan',building:'260',street:'6 AVENUE',zipcode:'10014',latitude:'40.729094977878',longitude:'-74.002467899133',latest_inspection:'2026-10-01'},
  {camis:'10000001',dba:'CAFÉ TEST',boro:'Brooklyn',building:'20',street:'TEST STREET',zipcode:'11201',latitude:'40.7',longitude:'-73.99'},
  {camis:'10000002',dba:'NEW YORK PIZZA',boro:'Queens',building:'50',street:'TEST AVENUE',zipcode:'11101',latitude:'40.75',longitude:'-73.92'}
];
const restaurants=restaurantPlaces(rows);
const feature=(name='Chada NYC',coordinates=[-74.00247,40.7291])=>({properties:{name,housenumber:'260',street:'6 Avenue',city:'New York',osm_type:'N',osm_id:123},geometry:{coordinates}});
const response=features=>Response.json({features});

test('inspection rows become one real NYC destination per permit, with full address',()=>{
  const places=restaurantPlaces([...rows,{...rows[0],dba:'OLD NAME',latest_inspection:'2020-01-01'},{...rows[0],camis:'999',latitude:'0'},{...rows[0],camis:'998',longitude:null},{...rows[0],camis:'997',dba:''},{...rows[0],camis:'996',latitude:'41.5'}]);
  assert.equal(places.length,3);
  const chada=places.find(place=>place.name==='CHADA');
  assert.equal(chada.neighborhood,'260 6 Avenue · Manhattan 10014');
  assert.equal(chada.coordinate.latitude,40.729094977878);
});

test('restaurant names tolerate accents, punctuation, and a trailing NYC qualifier',()=>{
  for(const query of ['chada','CHADA NYC','chada in New York City','chada new york'])assert.equal(searchRestaurantPlaces(restaurants,query)[0].name,'CHADA',query);
  assert.equal(searchRestaurantPlaces(restaurants,'cafe test')[0].name,'CAFÉ TEST');
  assert.equal(searchRestaurantPlaces(restaurants,'new york pizza')[0].name,'NEW YORK PIZZA');
  assert.equal(searchRestaurantPlaces(restaurants,'chada 260')[0].name,'CHADA');
  assert.deepEqual(searchRestaurantPlaces(restaurants,'unrelated name'),[]);
});

test('an exact restaurant name is immediately selectable without the address provider',async()=>{
  const search=createPlaceSearch({restaurants,dataUpdatedAt:'2026-11-17T18:00:02.000Z',fetcher:()=>{assert.fail('Exact local names must not wait for Photon');}});
  const result=await search('chada nyc');
  assert.equal(result.places[0].name,'CHADA');assert.equal(result.places[0].selectable,true);
  assert.equal(result.restaurantDataUpdatedAt,'2026-11-17T18:00:02.000Z');
});

test('partial names combine both sources and preserve distinct branches',async()=>{
  let requested;
  const branch={...restaurants.find(place=>place.name==='CHADA'),id:'branch',coordinate:{latitude:40.78,longitude:-73.96},neighborhood:'Second address'};
  const search=createPlaceSearch({restaurants:[...restaurants,branch],fetcher:async(url,options)=>{requested=url;assert(options.signal);return response([feature(),feature('Chai House',[-73.98,40.75])]);}});
  const result=await search('cha');
  assert.equal(requested.searchParams.get('bbox'),'-74.27,40.48,-73.67,40.94');
  assert.equal(result.places.filter(place=>/^chada/i.test(place.name)).length,2);
  assert(result.places.some(place=>place.name==='Chai House'));
});

test('a slow/unavailable address provider still returns local restaurant matches',async()=>{
  const search=createPlaceSearch({restaurants,fetcher:async()=>{throw Error('Offline');}});
  const result=await search('chad');assert.equal(result.places[0].name,'CHADA');assert.equal(result.partial,true);
  await assert.rejects(search('unknown address'),error=>error.status===503&&/temporarily unavailable/.test(error.message));
});

test('address searches retain street numbers and reject malformed or non-NYC coordinates',()=>{
  const places=photonPlaces({features:[feature(),feature('Outside',[-71,42]),feature('Missing',[null,40.73]),feature('Short',[-74])]},'chada');
  assert.equal(places.length,1);assert.equal(places[0].neighborhood,'260 6 Avenue · New York');
  assert.deepEqual(photonPlaces({},'query'),[]);
});

test('duplicate names merge only when coordinates identify the same location',()=>{
  const local=restaurants.find(place=>place.name==='CHADA'),remote=photonPlaces({features:[feature()]},'chada');
  assert.equal(mergePlaces([[local],remote],'chada nyc').length,1);
  assert.equal(mergePlaces([[local],[{...remote[0],coordinate:{latitude:40.8,longitude:-73.9}}]],'chada').length,2);
});

test('repeated and concurrent lookups share a bounded cache, then refresh',async()=>{
  let calls=0,now=1000,release;
  const search=createPlaceSearch({now:()=>now,fetcher:async()=>{calls++;await new Promise(resolve=>{release=resolve;});return response([feature('Test landmark')]);}});
  const first=search('test landmark'),second=search('TEST landmark');assert.equal(calls,1);release();
  assert.deepEqual(await first,await second);await search('test landmark');assert.equal(calls,1);
  now+=300001;const next=search('test landmark');assert.equal(calls,2);release();await next;
});

test('empty input preserves saved destinations and malformed provider responses report failure',async()=>{
  const landmarks=[{...restaurants[0],id:'landmark'}],search=createPlaceSearch({landmarks,fetcher:async()=>Response.json({unexpected:[]})});
  assert.deepEqual((await search('')).places,landmarks);
  await assert.rejects(search('missing'),error=>error.status===503);
});
