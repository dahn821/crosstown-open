import test from 'node:test';
import assert from 'node:assert/strict';
import {canChooseDeparture,departureOptions,resolveDeparture} from '../dist/transit-choices.mjs';
const now=Date.now(),iso=offset=>new Date(now+offset*1000).toISOString();
const option=(id,departure=600)=>({id,groupId:'corridor',choiceId:id,alternativeIds:['first','later'],departureTime:iso(0),minutes:20,legs:[{mode:'walk',duration:5},{mode:'subway',line:'B',tripId:id,realtime:true,predictionReportedAt:iso(-10),departureTime:iso(departure)}]});
test('later departures resolve to the complete selected itinerary and retain the card identity',()=>{
 const route={...option('first'),id:'corridor'},later=option('later',900),response={alternativeRoutes:{later}};
 assert.equal(resolveDeparture(route,response,{corridor:'later'}).legs[1].departureTime,iso(900));
 assert.equal(resolveDeparture(route,response,{corridor:'later'}).id,'corridor');
 assert.equal(resolveDeparture(route,response,{corridor:'missing'}),route);
});
test('unreachable and stale predictions cannot be selected',()=>{
 assert(canChooseDeparture(option('first'),now));assert(!canChooseDeparture(option('first',320),now));
 const stale=option('first');stale.legs[1].predictionReportedAt=iso(-181);assert(!canChooseDeparture(stale,now));
 assert(!canChooseDeparture(option('first'),now+600000));
});
test('a later second leg never silently changes an already selected first train',()=>{
 const first=option('first'),later=option('later');for(const route of [first,later])route.legs.push({mode:'subway',line:'D',tripId:'second-'+route.id,departureTime:iso(1400)});
 const response={alternativeRoutes:{first,later}};assert.deepEqual(departureOptions(first,2,response,now).map(route=>route.id),['first']);
});
