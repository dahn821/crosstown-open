import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,routeTitle} from '../dist/preferences.mjs';
test('new searches require live transit and changing one trip cannot alter another',()=>{const a=defaults(),b=defaults();a.modes.pop();a.maxFareCents=100;assert.equal(b.modes.length,4);assert.equal(b.requireLiveTransit,true);assert.equal(b.maxFareCents,1500);});
test('route titles preserve bike to train and train to bike connections',()=>{assert.equal(routeTitle({legs:[{mode:'walk'},{mode:'bike',bikeSource:'citiBike'},{mode:'walk'},{mode:'subway',line:'6'}]}),'Citi Bike → 6');assert.equal(routeTitle({legs:[{mode:'subway',line:'Q'},{mode:'bike',bikeSource:'ownBike'}]}),'Q → My bike');assert.equal(routeTitle({legs:[{mode:'walk'}]}),'Walk');});
