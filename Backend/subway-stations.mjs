export const stationRadius=1200;
export const platformID=id=>String(id||'').split(':').at(-1);
export const stationStopID=id=>platformID(id).replace(/[NS]$/,'');
const localLine=line=>String(line||'').replace(/^([67])X$/,'$1');
const distance=(a,b)=>Math.hypot((a.latitude-b.latitude)*111200,(a.longitude-b.longitude)*84200);

export function subwayDirection(stopId,station){
  const platform=platformID(stopId);
  const north=platform.endsWith('N'),south=platform.endsWith('S');
  if(!north&&!south)return '';
  const label=(north?station?.north_direction_label:station?.south_direction_label)?.trim();
  return !label||/^(northbound|southbound)$/i.test(label)?north?'Uptown':'Downtown':label;
}

export function subwayStations(stops={},stationRows=[]){
  const metadata=new Map(stationRows.map(row=>[String(row.gtfs_stop_id),row]));
  const complexes=new Map(),complexByStop=new Map();
  for(const [id,stop] of Object.entries(stops)){
    if(!Number.isFinite(stop.latitude)||!Number.isFinite(stop.longitude))continue;
    const base=stop.parent||stationStopID(id),row=metadata.get(base);
    const complexId=row?.complex_id?'subway-complex:'+row.complex_id:'nyct:'+base;
    let station=complexes.get(complexId);
    if(!station){
      station={id:complexId,platforms:[],daytimeRoutes:new Set()};
      complexes.set(complexId,station);
    }
    complexByStop.set(base,complexId);
    for(const route of String(row?.daytime_routes||'').split(/\s+/).filter(Boolean))station.daytimeRoutes.add(route);
    station.platforms.push({gtfsId:'nyct:'+id,name:row?.stop_name||stop.name,lat:stop.latitude,lon:stop.longitude,vehicleMode:'SUBWAY'});
  }
  const resolve=id=>complexes.has(id)?id:complexByStop.get(stationStopID(id));
  return {metadata,complexes,resolve};
}

export function nearbySubwayBoard(store,coordinate,{stop,line}={},now=Date.now()){
  const catalog=store.subwayCatalog,selected=stop?catalog.resolve(stop):null;
  const complexes=selected?[catalog.complexes.get(selected)]:stop?[]:catalog.complexes.values();
  const nearby=[];
  for(const station of complexes){
    const platforms=station.platforms.map(platform=>({...platform,stationId:station.id,distance:distance(coordinate,{latitude:platform.lat,longitude:platform.lon})}));
    const closest=platforms.reduce((a,b)=>a.distance<=b.distance?a:b);
    if(!selected&&closest.distance>stationRadius)continue;
    nearby.push({id:station.id,name:closest.name,coordinate:{latitude:closest.lat,longitude:closest.lon},metersAway:Math.round(closest.distance),daytimeRoutes:station.daytimeRoutes,platforms});
  }
  nearby.sort((a,b)=>a.metersAway-b.metersAway||a.name.localeCompare(b.name));
  const candidates=line?nearby:nearby.slice(0,4);
  const departures=store.departures(candidates.flatMap(station=>station.platforms),now,{mode:'subway',line,limit:Infinity});
  const active=new Set(departures.map(departure=>departure.stationId));
  const stations=candidates.filter(station=>selected||!line||active.has(station.id)||station.daytimeRoutes.has(localLine(line))).slice(0,4).map(({platforms,daytimeRoutes,...station})=>station);
  const included=new Set(stations.map(station=>station.id));
  return {stations,departures:departures.filter(departure=>included.has(departure.stationId))};
}
