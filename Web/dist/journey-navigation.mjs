const metersPerDegree = {latitude:111200, longitude:84200};
const coordinate = point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
  && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
const distance = (a,b) => Math.hypot((a.latitude-b.latitude)*metersPerDegree.latitude,
  (a.longitude-b.longitude)*metersPerDegree.longitude);
const transit = leg => leg.mode === 'bus' || leg.mode === 'subway';

export function journeyFix(position, now = Date.now()) {
  const point = position?.coords;
  const age = now - position?.timestamp;
  if (!coordinate(point) || !Number.isFinite(point.accuracy) || point.accuracy < 0 || point.accuracy > 60
    || !Number.isFinite(age) || age < -5000 || age > 20000) return null;
  const heading = point.speed > 0.7 && Number.isFinite(point.heading) && point.heading >= 0 && point.heading < 360 ? point.heading : null;
  return {latitude:point.latitude, longitude:point.longitude, accuracy:point.accuracy, heading, timestamp:position.timestamp};
}

function routePath(points) {
  let offset = 0;
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i-1], end = points[i];
    const dx = (end.longitude-start.longitude)*metersPerDegree.longitude;
    const dy = (end.latitude-start.latitude)*metersPerDegree.latitude;
    const length = Math.hypot(dx,dy);
    if (length < 0.5) continue;
    segments.push({start, dx, dy, offset, length});
    offset += length;
  }
  return {segments, length:offset, end:points.at(-1)};
}

function project(path, point, minimum = 0, maximum = path.length) {
  let best = null;
  for (const {start,dx,dy,offset,length} of path.segments) {
    const low = Math.max(0,minimum-offset), high = Math.min(length,maximum-offset);
    if (low > high) continue;
    const x = (point.longitude-start.longitude)*metersPerDegree.longitude;
    const y = (point.latitude-start.latitude)*metersPerDegree.latitude;
    const along = Math.max(low,Math.min(high,(x*dx+y*dy)/length));
    const away = Math.hypot(x-dx*along/length,y-dy*along/length);
    if (!best || away < best.away) best = {away, along:offset+along};
  }
  return best;
}

const directions = {
  LEFT:'Turn left', RIGHT:'Turn right', SLIGHTLY_LEFT:'Bear left', SLIGHTLY_RIGHT:'Bear right',
  SLIGHT_LEFT:'Bear left', SLIGHT_RIGHT:'Bear right', HARD_LEFT:'Turn sharply left', HARD_RIGHT:'Turn sharply right',
  UTURN_LEFT:'Make a U-turn', UTURN_RIGHT:'Make a U-turn', CIRCLE_CLOCKWISE:'Enter the roundabout',
  CIRCLE_COUNTERCLOCKWISE:'Enter the roundabout', ELEVATOR:'Take the elevator', STAIRS:'Take the stairs',
};

function expectedTurns(leg,path) {
  const turns = [];
  let previous = 0;
  for (const step of leg.steps || []) {
    const point = {latitude:step.lat, longitude:step.lon};
    if (!coordinate(point)) continue;
    const match = project(path,point,Math.max(0,previous-3));
    if (!match || match.away > 25) continue;
    previous = Math.max(previous,match.along);
    const street = step.streetName?.trim();
    const heading = String(step.relativeDirection || '').toUpperCase();
    const direction = step.walkingBike ? 'Walk your bike' : directions[heading];
    if (!direction || previous <= 7 || previous <= (turns.at(-1)?.at ?? -10)+7) continue;
    turns.push({at:previous, instruction:street ? `${direction} onto ${street}` : direction});
  }
  return turns;
}

function pointAt(path,offset) {
  const segment = path.segments.find(segment=>segment.offset+segment.length>=offset);
  if (!segment) return path.end;
  const fraction = (offset-segment.offset)/segment.length;
  return {latitude:segment.start.latitude+fraction*segment.dy/metersPerDegree.latitude,
    longitude:segment.start.longitude+fraction*segment.dx/metersPerDegree.longitude};
}

function geometryTurns(path,mode) {
  const sampleDistance = mode === 'bike' ? 30 : 22;
  const turns = [];
  for (const {start,offset} of path.segments) {
    if (offset < sampleDistance || path.length-offset < sampleDistance) continue;
    const before = pointAt(path,offset-sampleDistance), after = pointAt(path,offset+sampleDistance);
    const eastIn = (start.longitude-before.longitude)*metersPerDegree.longitude;
    const northIn = (start.latitude-before.latitude)*metersPerDegree.latitude;
    const eastOut = (after.longitude-start.longitude)*metersPerDegree.longitude;
    const northOut = (after.latitude-start.latitude)*metersPerDegree.latitude;
    if (Math.min(Math.hypot(eastIn,northIn),Math.hypot(eastOut,northOut)) < sampleDistance*.7) continue;
    const angle = Math.atan2(eastIn*northOut-northIn*eastOut,eastIn*eastOut+northIn*northOut)*180/Math.PI;
    const strength = Math.abs(angle);
    // Looking some distance either way suppresses sidewalk bends and tiny
    // connectors. A geometric turn supplies direction only, never a street name.
    if (strength < 48) continue;
    const instruction = strength >= 155 ? 'Make a U-turn' : angle > 0 ? 'Turn left' : 'Turn right';
    const candidate = {at:offset,instruction,strength};
    const previous = turns.at(-1);
    if (previous && offset-previous.at < sampleDistance) {
      if (strength > previous.strength) turns[turns.length-1] = candidate;
    } else turns.push(candidate);
  }
  return turns;
}

function prepare(leg) {
  const points = (leg.coordinates || []).filter(coordinate);
  // A straight line between endpoints is useful on the preview map. It isn't
  // a street path a traveler can follow through a building or across water.
  const path = routePath(points);
  if (transit(leg)) return {leg,path,turns:[]};
  const provided = expectedTurns(leg,path);
  const turns = provided.length ? provided : geometryTurns(path,leg.mode);
  return {leg,path,turns};
}

function firstPhase(leg) {
  if (!leg) return 'arrived';
  if (transit(leg)) return 'board';
  return leg.bikePickup ? 'pickup' : 'street';
}

export function createJourneyProgress(route,{now=Date.now}={}) {
  const legs = route.legs.map(prepare);
  let index = 0, phase = firstPhase(legs[0]?.leg), travelled = 0;
  let fix = null, lastMatched = null, awayCount = 0, nearingEnd = false, joining = false;

  function advance() {
    index++;
    phase = firstPhase(legs[index]?.leg);
    travelled = 0;
    lastMatched = null;
    awayCount = 0;
    nearingEnd = false;
    joining = false;
  }

  function finishStreet() {
    if (legs[index].leg.bikeReturn) phase = 'return';
    else advance();
  }

  function snapshot() {
    const current = legs[index];
    const turn = current?.turns.find(turn => turn.at >= travelled-5);
    const remaining = current ? Math.max(0,current.path.length-travelled) : 0;
    return {index, phase, leg:current?.leg, turn, distanceToTurn:turn ? Math.max(0,turn.at-travelled) : remaining, joining,
      fix:fix && now()-fix.timestamp <= 20000 ? fix : null, offRoute:awayCount >= 2,
      hasPath:Boolean(current?.path.length), remaining};
  }

  function update(position) {
    const next = journeyFix(position,now());
    if (!next || next.timestamp <= (fix?.timestamp ?? -Infinity)) return snapshot();
    fix = next;
    if (phase !== 'street') return snapshot();
    const {leg,path} = legs[index];
    if (!path.length) return snapshot();

    // Progress only along the current leg. Limit forward jumps after acquiring
    // a fix so crossings and nearby parallel streets cannot skip many turns.
    const seconds = lastMatched ? (next.timestamp-lastMatched)/1000 : 0;
    const possibleProgress = (leg.mode === 'bike' ? 15 : 4)*seconds;
    const maximum = lastMatched ? travelled+Math.max(55,possibleProgress+next.accuracy) : path.length;
    const match = project(path,next,Math.max(0,travelled-30),maximum);
    if (!match || match.away > Math.max(32,next.accuracy+15)) {
      joining = travelled < 5 && coordinate(leg.from?.coordinate) && distance(leg.from.coordinate,next) <= 40;
      awayCount = joining ? 0 : awayCount+1;
      nearingEnd = false;
      return snapshot();
    }
    awayCount = 0;
    joining = false;
    travelled = Math.max(travelled,match.along);
    lastMatched = next.timestamp;
    const atEnd = next.accuracy <= 30 && path.length-travelled <= 17 && distance(next,path.end) <= 20;
    if (atEnd && nearingEnd) finishStreet();
    else nearingEnd = atEnd;
    return snapshot();
  }

  function confirm() {
    switch (phase) {
      case 'pickup': phase = 'street'; break;
      case 'board': phase = 'ride'; break;
      case 'street': finishStreet(); break;
      case 'ride':
      case 'return': advance(); break;
    }
    return snapshot();
  }

  return {update, confirm, snapshot};
}
