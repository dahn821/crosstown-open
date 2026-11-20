import {busStopID,busStopName} from './feeds.mjs';
import {createTripGeometry} from './subway-shapes.mjs';

const byStore=new WeakMap();
const agencies=['MTA NYCT','MTABC'];

function decodeLine(encoded){
  if(typeof encoded!=='string'||!encoded.length||encoded.length>25000)return [];
  const points=[];let index=0,lat=0,lon=0;
  function component(){
    let total=0,shift=0,value;
    do{
      if(index>=encoded.length||shift>30)throw Error('Invalid polyline');
      value=encoded.charCodeAt(index++)-63;
      if(value<0||value>63)throw Error('Invalid polyline');
      total|=(value&31)<<shift;shift+=5;
    }while(value>=32);
    return total&1?~(total>>1):total>>1;
  }
  while(index<encoded.length){lat+=component();lon+=component();points.push([lat/1e5,lon/1e5]);}
  return points;
}

function routeData(payload){
  const entry=payload?.data?.entry,refs=payload?.data?.references;
  if(!entry||!Array.isArray(refs?.stops))return null;
  const stops=new Map(refs.stops.filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon)).map(s=>[busStopID(s.id),s]));
  function shapes(polylines){
    return (polylines||[]).map(item=>{
      try{return decodeLine(item.points);}catch{return [];}
    }).filter(points=>points.length>=2);
  }
  const groups=(entry.stopGroupings||[]).flatMap(group=>group.stopGroups||[]).map(group=>({
    id:String(group.id),points:shapes(group.polylines)
  }));
  return {stops,groups,points:shapes(entry.polylines)};
}

export async function loadBusRoute(store,routeId,vehicle){
  if(!store.busKey||typeof routeId!=='string')return null;
  const raw=routeId.match(/^(?:(MTA NYCT|MTABC)_)?([A-Z0-9+ -]{1,24})$/i);
  if(!raw)return null;
  const route=raw[2].replace(/-SBS$/i,'+'),hint=raw[1]||vehicle?.vehicle?.id?.split('_')[0];
  const preferred=agencies.find(agency=>agency===hint)||(/^(?:BM|BxM|QM|Q[M]?1\d\d|B10[03]|B110)/i.test(route)?'MTABC':'MTA NYCT');
  let cache=byStore.get(store);if(!cache){cache=new Map();byStore.set(store,cache);}
  const key=preferred+'_'+route,cached=cache.get(key);
  if(cached&&cached.until>Date.now())return cached.result;
  const item={until:Infinity,result:null};
  item.result=(async()=>{
    for(const agency of [preferred,...agencies.filter(a=>a!==preferred)]){
      const url=new URL('/api/where/stops-for-route/'+encodeURIComponent(agency+'_'+route)+'.json','https://bustime.mta.info');
      url.searchParams.set('key',store.busKey);
      url.searchParams.set('version','2');
      url.searchParams.set('includePolylines','true');
      try{
        const response=await store.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(2600)});
        if(!response.ok)continue;
        const data=routeData(await response.json());
        if(data?.stops.size){item.until=Date.now()+6*3600000;return data;}
      }catch{/* A missing shape must not prevent displaying live arrival times. */}
    }
    item.until=Date.now()+120000;
    return null;
  })();
  if(cache.size>=160)cache.delete(cache.keys().next().value);
  cache.set(key,item);
  return item.result;
}

export async function busLineStops(store,line){
  const data=await loadBusRoute(store,line);
  return data?[...data.stops.values()].map(stop=>({gtfsId:stop.id,name:busStopName(stop.name),lat:stop.lat,lon:stop.lon})):null;
}

export async function busLineNetwork(store,line){
  const data=await loadBusRoute(store,line);
  if(!data)return {segments:[],stations:[],unmatchedSegments:0};
  const directional=data.groups.flatMap(group=>group.points);
  const paths=directional.length?directional:data.points;
  return {
    segments:paths.map(points=>({line,color:'2262AA',points})),
    stations:[...data.stops.values()].map(stop=>({id:stop.id,name:busStopName(stop.name),coordinate:{latitude:stop.lat,longitude:stop.lon}})),
    unmatchedSegments:0
  };
}

export function busTripSegments(data,directionId,predictions,gps){
  if(!data)return [];
  const stops=Object.fromEntries([...data.stops].map(([id,stop])=>[id,{latitude:stop.lat,longitude:stop.lon}]));
  const direction=data.groups.find(group=>group.id===String(directionId));
  const preferred=direction?.points.length?direction.points:[...data.groups.flatMap(group=>group.points),...data.points];
  const shapes=Object.fromEntries(preferred.map((points,index)=>['B.'+index,points]));
  if(gps)stops.current=gps;
  const geometry=createTripGeometry(stops,shapes,{maxSnapMeters:55,allowOtherLines:false,detourFactor:3.2});
  const ids=[...(gps?['current']:[]),...predictions.map(item=>busStopID(item.stopId))];
  return ids.flatMap((from,index)=>{
    const to=ids[index+1];
    const path=to&&geometry('B',null,from,to,{previous:ids[index-1],next:ids[index+2]});
    return path?[path]:[];
  });
}
