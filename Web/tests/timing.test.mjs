import test from 'node:test';
import assert from 'node:assert/strict';
import {nyLocalInput,nyTimeToISO,timingPayload} from '../dist/timing.mjs';

test('custom times use New York time regardless of the computer timezone',()=>{
  assert.equal(nyTimeToISO('2026-11-18T09:30'),'2026-11-18T14:30:00.000Z');
  assert.equal(nyTimeToISO('2026-07-18T09:30'),'2026-07-18T13:30:00.000Z');
  assert.equal(nyLocalInput('2026-11-18T14:30:00Z'),'2026-11-18T09:30');
});
test('invalid dates and nonexistent daylight-saving times are rejected',()=>{
  assert.equal(nyTimeToISO('2026-03-08T02:30'),null);
  assert.equal(nyTimeToISO('2026-02-30T12:00'),null);
  assert.equal(nyTimeToISO('not-a-date'),null);
});
test('arrival deadlines are distinct from departures and fixed across refreshes',()=>{
  const time='2026-11-18T14:30:00.000Z';
  assert.deepEqual(timingPayload({mode:'arriveBy',time}),{arrivalTime:time});
  assert.deepEqual(timingPayload({mode:'departAt',time}),{departureTime:time});
  assert.deepEqual(timingPayload({mode:'now',time}),{});
});
