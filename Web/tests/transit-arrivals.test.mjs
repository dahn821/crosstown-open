import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivalLabel,trainIsDue,vehicleReports} from '../dist/transit-arrivals.mjs';
import {sampleTrack} from '../dist/track-position.mjs';

const now=Date.now();
const at=offset=>new Date(now+offset*1000).toISOString();
const coordinate={latitude:40.75,longitude:-73.99};
const old={latitude:40.76,longitude:-73.98};
const calls={arrivalTime:at(30),departureTime:at(70)};
const board={...calls,mode:'subway',line:'1',trackingId:'specific-train',predictionReportedAt:at(-20),
  direction:'Downtown',stop:{id:'nyct:128S',name:'Times Sq',coordinate}};
const report={id:'marker',trackingId:board.trackingId,mode:'subway',line:'1',accuracy:'reported-stop',coordinate:old,reportedAt:at(-30),
  positionReport:{accuracy:'reported-stop',coordinate:old,stopId:'127S',stopName:'Previous station',reportedAt:at(-30)}};

test('arrival countdown uses MTA arrival and stays due until the reported departure',()=>{
  assert.equal(arrivalLabel(calls,now),'Due');
  assert.equal(arrivalLabel(calls,now+60000),'Due');
  assert.equal(arrivalLabel(calls,now+71000),'Departed');
  assert.equal(arrivalLabel({departureTime:at(91)},now),'2 min');
});

test('the selected station can align its exact due trip even when the position snapshot is behind',()=>{
  const [aligned]=vehicleReports([report],[board],now);
  assert.equal(aligned.accuracy,'prediction-stop');
  assert.equal(aligned.nextStop.stopId,'128S');
  assert.equal(aligned.trackingId,board.trackingId);
  assert.deepEqual(aligned.coordinate,coordinate);
  assert(trainIsDue(aligned,now));
  assert.equal(vehicleReports([aligned],[board],now+71000).length,0);
  const later={...aligned,nextStop:{...aligned.nextStop,departureTime:at(45)}};
  assert.deepEqual(vehicleReports([later],[],now+46000)[0].coordinate,old);
  const other={...board,trackingId:'opposite-trip',direction:'Uptown'};
  assert.equal(vehicleReports([],[board,other],now).length,2);
});

test('confirmed station reports and genuine GPS keep their own source and coordinates',()=>{
  const gps={...report,accuracy:'gps'};
  assert.deepEqual(vehicleReports([gps],[board],now),[gps]);
  const confirmed={...report,coordinate,positionReport:{...report.positionReport,stopId:'128S',coordinate}};
  const [vehicle]=vehicleReports([confirmed],[board],now);
  assert.equal(vehicle.accuracy,'reported-stop');
  assert(trainIsDue(vehicle,now));
  assert.deepEqual(vehicleReports([],[{...board,predictionReportedAt:at(-181)}],now),[]);
});

test('a moving train stays on the track, uses the matching station count, and stops at arrival',()=>{
  const motion={startedAt:now-30000,arrivesAt:now+30000,expiresAt:now+90000,
    points:[[40.75,-74,0],[40.75,-73.99,800],[40.76,-73.99,1800]]};
  assert(sampleTrack(motion,now).coordinate.latitude>40.75);
  const moving={...report,accuracy:'interpolated',motion,
    nextStop:{stopId:'128S',...(calls),reportedAt:at(-15)}};
  const row={...board,estimateSource:'vehicle-reports',isNextStop:true,arrivalTime:at(40)};
  const [aligned]=vehicleReports([moving],[row],now);
  assert.equal(aligned.accuracy,'interpolated');
  assert.equal(aligned.motion.arrivesAt,now+40000);
  assert.notDeepEqual(aligned.coordinate,row.stop.coordinate);
  assert.deepEqual(sampleTrack(aligned.motion,now+42000).coordinate,{latitude:40.76,longitude:-73.99});
  assert.equal(sampleTrack(aligned.motion,now+91000),null);
  assert.deepEqual(vehicleReports([],[row],now),[]);
});
