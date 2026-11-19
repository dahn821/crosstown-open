import {busStopID,busStopName} from './feeds.mjs';

export const busStopRadius=1200;
const boardSize=4;
const meters=(point,stop)=>Math.hypot((point.latitude-stop.lat)*111200,(point.longitude-stop.lon)*84200);
const intersectionKey=name=>name.toUpperCase().split(' / ').sort().join('|');

function groupIntersections(stops){
  const groups=[],byName=new Map();
  for(const stop of stops){
    const key=intersectionKey(stop.name),nearby=byName.get(key)||[];
    let group=nearby.find(item=>meters(item.coordinate,stop)<=120);
    if(!group){
      group={id:stop.gtfsId,name:stop.name,coordinate:{latitude:stop.lat,longitude:stop.lon},
        metersAway:Math.round(stop.distance),members:[]};
      nearby.push(group);byName.set(key,nearby);groups.push(group);
    }
    group.members.push(stop.gtfsId);
    stop.stationId=group.id;
  }
  return groups;
}

export function nearbyBusBoard(store,busStops,coordinate,{stop,line}={},now=Date.now()){
  const focused=stop&&busStopID(stop),nearby=[];
  for(const item of busStops){
    if(!Number.isFinite(item.lat)||!Number.isFinite(item.lon))continue;
    const distance=meters(coordinate,item),selected=focused&&busStopID(item.gtfsId)===focused;
    if(!selected&&distance>busStopRadius)continue;
    nearby.push({...item,name:busStopName(item.name),distance,vehicleMode:'BUS'});
  }
  nearby.sort((a,b)=>a.distance-b.distance||a.name.localeCompare(b.name)||a.gtfsId.localeCompare(b.gtfsId));
  const groups=groupIntersections(nearby);
  const candidates=focused?groups.filter(group=>group.members.some(id=>busStopID(id)===focused)):line?groups:groups.slice(0,boardSize);
  const stopIds=new Set(candidates.flatMap(group=>group.members));
  const departures=store.departures(nearby,now,{mode:'bus',line,stopIds,limit:Infinity});
  const liveStops=new Set(departures.map(departure=>departure.stationId));
  const stations=candidates.filter(group=>focused||!line||liveStops.has(group.id)).slice(0,boardSize).map(({members,...group})=>group);
  const visible=new Set(stations.map(item=>item.id));
  return {stations,departures:departures.filter(item=>visible.has(item.stationId))};
}
