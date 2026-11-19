import {busID, lineFeeds} from './feeds.mjs';

export function rideQuery(params) {
  const mode = params.get('mode');
  const line = params.get('line');
  const trip = params.get('trip');
  const from = params.get('from');
  const to = params.get('to');
  const departure = Date.parse(params.get('departure'));
  const field = (value,limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
  const validLine = mode === 'bus' ? field(line,20) && Boolean(busID(line)) : mode === 'subway' && Object.hasOwn(lineFeeds,line);
  if (!validLine || !field(trip,220) || !field(from,60) || !field(to,60) || from === to || !Number.isFinite(departure)) {
    throw Object.assign(Error('Choose a reported subway or bus trip.'),{status:400});
  }
  return {mode,line,trip,from,to,departure,feed:mode === 'bus' ? 'bus' : lineFeeds[line]};
}

function time(stop,first,second) {
  const seconds = Number((stop?.[first]?.time || stop?.[second]?.time)?.toString());
  return Number.isFinite(seconds) && seconds > 0 ? seconds*1000 : null;
}

export function ridePrediction(store,query) {
  const {mode,line,trip,from,to,feed} = query;
  const entry = store.entries.get(feed);
  if (!entry || store.freshness(feed).stale) return {status:'unavailable'};
  const equal = mode === 'bus' ? (a,b) => busID(a) === busID(b) : (a,b) => a === b;
  const candidates = [];
  for (const entity of entry.message?.entity || []) {
    const update = entity.tripUpdate;
    if (update?.trip?.tripId !== trip || !equal(update.trip.routeId,line)) continue;
    const calls = update.stopTimeUpdate || [];
    const fromIndex = calls.findIndex(call=>equal(call.stopId,from));
    const board = calls[fromIndex];
    // Feeds can remove the boarding call as the trip proceeds. Keep the
    // alighting prediction for this exact trip as long as that stop is reported.
    const alight = calls.find((call,index)=>index>fromIndex && equal(call.stopId,to));
    const departure = time(board,'departure','arrival');
    const arrival = time(alight,'arrival','departure');
    const changed = entity.isDeleted || [3,7].includes(update.trip.scheduleRelationship)
      || board?.scheduleRelationship === 1 || alight?.scheduleRelationship === 1;
    const boardTime = board?.scheduleRelationship === 2 ? null : departure;
    const alightTime = alight?.scheduleRelationship === 2 || (boardTime && arrival < boardTime) ? null : arrival;
    const score = departure ? Math.abs(departure-query.departure) : arrival ? Math.abs(arrival-query.departure)+3600000 : Infinity;
    candidates.push({changed,boardTime,alightTime,score});
  }
  const best = candidates.sort((a,b)=>a.score-b.score)[0];
  if (!best || (!best.changed && !best.boardTime && !best.alightTime)) return {status:'unavailable'};
  const reportedAt = new Date(entry.sourceTimestamp).toISOString();
  if (best.changed) return {status:'changed',reportedAt};
  return {status:'live',reportedAt,
    departureTime:best.boardTime ? new Date(best.boardTime).toISOString() : null,
    arrivalTime:best.alightTime ? new Date(best.alightTime).toISOString() : null};
}
