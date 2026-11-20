import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivalLabel,subwayArrivalLabel,trainIsDue,vehicleReports} from '../dist/transit-arrivals.mjs';
import {sampleTrack} from '../dist/track-position.mjs';

const now=Date.now();
const at=offset=>new Date(now+offset*1000).toISOString();
const platform={latitude:40.76,longitude:-73.99};
const board={arrivalTime:at(35),departureTime:at(70),mode:'subway',line:'E',trackingId:'specific-train',
  isNextStop:true,direction:'Uptown',stop:{id:'nyct:A31N',name:'14 St',coordinate:platform}};
const motion={startedAt:now-30000,arrivesAt:now+30000,expiresAt:now+90000,fromStopId:'A32N',toStopId:'A31N',
  points:[[40.75,-74,0],[40.75,-73.99,800],[40.76,-73.99,1800]]};
const train={id:'marker',trackingId:board.trackingId,mode:'subway',line:'E',accuracy:'interpolated',coordinate:platform,reportedAt:at(-15),
  motion,nextStop:{stopId:'A31N',arrivalTime:at(30),departureTime:at(55),reportedAt:at(-15)},
  positionReport:{accuracy:'next-stop',coordinate:platform,stopId:'A31N',stopName:'14 St',reportedAt:at(-15)}};

test('bus countdown retains the published arrival and departure behavior',()=>{
  assert.equal(arrivalLabel(board,now),'Due');
  assert.equal(arrivalLabel(board,now+60000),'Due');
  assert.equal(arrivalLabel(board,now+71000),'Departed');
  assert.equal(arrivalLabel({departureTime:at(91)},now),'2 min');
});

test('subway Due requires the exact approaching vehicle, next platform, and under a minute of travel',()=>{
  assert(trainIsDue(train,'A31N',now));
  assert.equal(subwayArrivalLabel(board,train,now),'Due');
  assert.equal(subwayArrivalLabel(board,undefined,now),'1 min');
  assert.equal(subwayArrivalLabel({...board,trackingId:'another-train'},train,now),'1 min');
  assert.equal(subwayArrivalLabel({...board,isNextStop:false},train,now),'1 min');
  assert.equal(subwayArrivalLabel({...board,stop:{...board.stop,id:'nyct:A31S'}},train,now),'1 min');
  assert(!trainIsDue(train,'A30N',now));
  const minuteAway={...train,motion:{...motion,arrivesAt:now+60000}};
  assert(!trainIsDue(minuteAway,'A31N',now));
  assert.equal(subwayArrivalLabel(board,minuteAway,now),'1 min');
  const twoMinutesAway={...train,motion:{...motion,arrivesAt:now+95000}};
  assert.equal(subwayArrivalLabel(board,twoMinutesAway,now),'2 min');
});

test('stale, elapsed, and stationary reports do not mark trains Due',()=>{
  const stale={...train,positionReport:{...train.positionReport,reportedAt:at(-65)}};
  assert(!trainIsDue(stale,'A31N',now));
  assert.equal(subwayArrivalLabel(board,stale,now),'1 min');
  assert.equal(subwayArrivalLabel(board,train,now+30000),null);
  const atPlatform={...train,motion:null,accuracy:'reported-stop',positionReport:{...train.positionReport,accuracy:'reported-stop'}};
  assert.equal(subwayArrivalLabel(board,atPlatform,now),'At station');
  assert(!trainIsDue(atPlatform,'A31N',now));
  assert.equal(subwayArrivalLabel(board,{...train,motion:null},now),'1 min');
});

test('the marker follows the real track and never appears from a board row alone',()=>{
  assert.deepEqual(vehicleReports([],now),[]);
  const [moving]=vehicleReports([train],now);
  assert(moving.coordinate.latitude>40.75);
  assert.notDeepEqual(moving.coordinate,platform);
  assert.deepEqual(sampleTrack(motion,now+42000).coordinate,platform);
  const approach={...motion,stopOffset:25,startDistance:400};
  assert(sampleTrack(approach,now+42000).coordinate.latitude<platform.latitude);
  assert.equal(sampleTrack(motion,now+91000),null);
  assert.deepEqual(vehicleReports([train],now+90000),[]);
});
