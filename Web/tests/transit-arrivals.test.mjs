import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivalLabel,trainIsDue,vehicleReports} from '../dist/transit-arrivals.mjs';

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
