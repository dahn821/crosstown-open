import assert from 'node:assert/strict';
import test from 'node:test';
import {createJourneyProgress,journeyFix} from '../dist/journey-navigation.mjs';

const point=(east,north)=>({latitude:40.75+north/111200,longitude:-73.99+east/84200});
const place=(name,east,north)=>({name,coordinate:point(east,north)});
const walk={mode:'walk',coordinates:[point(0,0),point(0,100),point(90,100)],
  steps:[{lat:point(0,100).latitude,lon:point(0,100).longitude,relativeDirection:'RIGHT',streetName:'West 34th Street'}]};

function track(legs) {
  let time=100000;
  const navigation=createJourneyProgress({legs},{now:()=>time});
  function at(east,north,accuracy=10,elapsed=5000){
    time+=elapsed;
    return navigation.update({coords:{...point(east,north),accuracy,speed:1,heading:45},timestamp:time});
  }
  return {navigation,at};
}

test('GPS measures distance to a turn and advances only the completed walking leg',()=>{
  const train={mode:'subway',from:place('Boarding',90,100),to:place('Exit',2300,2000),coordinates:[]};
  const {navigation,at}=track([walk,train]);
  assert.match(at(0,0).turn.instruction,/Turn right onto West 34th Street/);
  assert(Math.abs(at(0,52).distanceToTurn-48)<1);
  assert.equal(at(8,100).turn,undefined);
  assert.equal(at(90,100,10,25000).phase,'street');
  assert.equal(at(92,102).phase,'board');
  assert.equal(at(2300,2000).phase,'board');
  assert.equal(navigation.confirm().phase,'ride');
  assert.equal(at(2300,2000).phase,'ride');
  assert.equal(navigation.confirm().phase,'arrived');
});

test('a single noisy fix is ignored, sustained deviation is reported, and returning clears it',()=>{
  const {at}=track([walk]);
  assert.equal(at(0,0).offRoute,false);
  assert.equal(at(65,5).offRoute,false);
  assert.equal(at(80,5,90).offRoute,false);
  assert.equal(at(65,10).offRoute,true);
  assert.equal(at(0,25).offRoute,false);
});

test('rental pickup and dock confirmation bracket the biking leg',()=>{
  const bike={...walk,mode:'bike',bikePickup:{name:'Pick up'},bikeReturn:{name:'Return'}};
  const {navigation,at}=track([bike]);
  assert.equal(at(0,0).phase,'pickup');
  assert.equal(navigation.confirm().phase,'street');
  assert.equal(at(90,100).phase,'street');
  assert.equal(at(90,100).phase,'return');
  assert.equal(navigation.confirm().phase,'arrived');
});

test('old and inaccurate fixes cannot advance guidance or add a heading',()=>{
  const coords={...point(0,0),accuracy:18,heading:120,speed:0};
  assert.equal(journeyFix({coords,timestamp:1},30000),null);
  assert.equal(journeyFix({coords:{...coords,accuracy:80},timestamp:100},200),null);
  assert.equal(journeyFix({coords,timestamp:100},200).heading,null);
});

test('geometry provides a turn when the street provider sends only continue steps',()=>{
  const {at}=track([{...walk,steps:[{...walk.steps[0],relativeDirection:'CONTINUE'}]}]);
  assert.equal(at(0,2).turn.instruction,'Turn right');
  assert.equal(Math.round(at(0,40).distanceToTurn),60);
});

test('a reported origin can be offset from the start of the street path',()=>{
  const {at}=track([{...walk,from:place('Station',-65,0)}]);
  at(-65,0);
  assert.equal(at(-63,0).joining,true);
  assert.equal(at(-63,0).offRoute,false);
  assert.equal(at(-6,0).joining,false);
});
