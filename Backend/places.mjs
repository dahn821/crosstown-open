const bounds={south:40.48,north:40.94,west:-74.27,east:-73.67};
export const restaurantSource='NYC DOHMH restaurant directory';
export const restaurantDataset='https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j';
export const restaurantEndpoint='https://data.cityofnewyork.us/resource/43nn-pn8j.json';
const inside=c=>Number.isFinite(c?.latitude)&&Number.isFinite(c?.longitude)&&c.latitude>=bounds.south&&c.latitude<=bounds.north&&c.longitude>=bounds.west&&c.longitude<=bounds.east;
export const normalizePlaceQuery=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
const variants=value=>{
  const query=normalizePlaceQuery(value),local=query.replace(/(?:\s+in)?\s+(?:nyc|new york(?: city)?)$/,'');
  return [...new Set([query,local].filter(Boolean))];
};
const title=value=>String(value??'').trim().replace(/\s+/g,' ').toLowerCase().replace(/\b[a-z]/g,c=>c.toUpperCase());
const distance=(a,b)=>Math.hypot((a.latitude-b.latitude)*111200,(a.longitude-b.longitude)*84200);

// The city repeats a restaurant for each inspection violation. Keep one permit,
// using its latest inspected name/address when historical variants are present.
export function restaurantPlaces(rows){
  const records=new Map();
  for(const row of rows){
    const coordinate={latitude:Number(row.latitude),longitude:Number(row.longitude)},id=String(row.camis??'').trim(),name=String(row.dba??'').trim().replace(/\s+/g,' ');
    const address=[row.building,title(row.street)].filter(Boolean).join(' ').trim(),borough=title(row.boro);
    if(!/^\d+$/.test(id)||!name||name.toLowerCase()==='unknown'||!address||!inside(coordinate))continue;
    const inspected=String(row.latest_inspection??row.inspection_date??'');
    if(records.has(id)&&records.get(id).inspected>=inspected)continue;
    records.set(id,{inspected,place:{id:'nyc-restaurant-'+id,name,neighborhood:[address,[borough,row.zipcode].filter(Boolean).join(' ')].filter(Boolean).join(' · '),coordinate,selectable:true}});
  }
  return [...records.values()].map(record=>record.place).sort((a,b)=>a.id.localeCompare(b.id));
}

function terms(place){
  const name=normalizePlaceQuery(place.name),all=normalizePlaceQuery(place.name+' '+place.neighborhood),words=name.split(' '),allWords=all.split(' ');
  return {place,name,words,allWords};
}

function score({name,words,allWords},queries){
  return Math.max(0,...queries.map(query=>{
    if(name===query)return 1000;
    if(name.startsWith(query))return 850;
    if(query.length<3)return 0;
    if(name.includes(query))return 750;
    const tokens=query.split(' ');
    if(tokens.every(token=>words.some(word=>word.startsWith(token))))return 650;
    if(tokens.every(token=>allWords.some(word=>word.startsWith(token))))return 500;
    return 0;
  }));
}

export function searchRestaurantPlaces(places,query,limit=12){
  return searchDirectory(places.map(terms),query,limit);
}

function searchDirectory(directory,query,limit=12){
  const queries=variants(query);
  if(!queries.length)return [];
  return directory.flatMap(entry=>{
    const match=score(entry,queries);
    return match?[{place:entry.place,score:match}]:[];
  }).sort((a,b)=>b.score-a.score||a.place.name.localeCompare(b.place.name)||a.place.neighborhood.localeCompare(b.place.neighborhood)).slice(0,limit).map(hit=>hit.place);
}

export function photonPlaces(data,query){
  return (Array.isArray(data?.features)?data.features:[]).flatMap(feature=>{
    const p=feature.properties??{},c=feature.geometry?.coordinates;
    if(!Array.isArray(c)||c.length<2)return [];
    const coordinate={latitude:c[1],longitude:c[0]};
    if(!inside(coordinate))return [];
    const address=[p.housenumber,p.street].filter(Boolean).join(' ');
    return [{id:'geo-'+String(p.osm_type??'')+String(p.osm_id??c.join(',')),name:p.name||address||query,neighborhood:[p.name?address:'',p.district||p.city||p.county].filter(Boolean).join(' · '),coordinate,selectable:true}];
  });
}

export function mergePlaces(groups,query,limit=12){
  const queries=variants(query),ranked=groups.flatMap((places,group)=>places.map((place,index)=>({place,score:score(terms(place),queries),group,index}))).sort((a,b)=>b.score-a.score||a.group-b.group||a.index-b.index),result=[];
  for(const {place} of ranked){
    if(result.some(existing=>existing.id===place.id||(variants(existing.name).some(name=>variants(place.name).includes(name))&&distance(existing.coordinate,place.coordinate)<100)))continue;
    result.push(place);if(result.length===limit)break;
  }
  return result;
}

export function createPlaceSearch({restaurants=[],landmarks=[],dataUpdatedAt=null,fetcher=fetch,timeoutMs=2000,now=Date.now}={}){
  const cache=new Map(),pending=new Map();
  let restaurantDirectory;
  const cityDirectory=landmarks.map(terms);
  return async function search(query,{directoryOnly=false}={}){
    const q=String(query??'').trim().slice(0,160),normalized=normalizePlaceQuery(q);
    if(!normalized)return {places:landmarks,source:'Saved city landmarks'};
    const key=(directoryOnly?'directory|':'')+normalized;
    const cached=cache.get(key);if(cached&&cached.until>now())return cached.result;
    if(pending.has(key))return pending.get(key);
    const job=(async()=>{
      restaurantDirectory??=restaurants.map(terms);
      const local=searchDirectory(restaurantDirectory,q),saved=searchDirectory(cityDirectory,q),queries=variants(q);
      const exact=[...saved,...local].some(place=>queries.includes(normalizePlaceQuery(place.name)));
      let remote=[],unavailable=false;
      // Exact local names need no network round trip. Prefix/address searches
      // also consult Photon so the restaurant directory cannot hide other POIs.
      if(!exact&&!directoryOnly){
        const endpoint=new URL('https://photon.komoot.io/api/');
        endpoint.search=new URLSearchParams({q,lat:'40.75',lon:'-73.98',limit:'12',bbox:`${bounds.west},${bounds.south},${bounds.east},${bounds.north}`}).toString();
        try{
          const response=await fetcher(endpoint,{signal:AbortSignal.timeout(timeoutMs),headers:{'User-Agent':'Crosstown/0.2 personal NYC trip planner'}});
          if(!response.ok)throw Error('Place provider unavailable');
          const data=await response.json();if(!Array.isArray(data.features))throw Error('Invalid place response');
          remote=photonPlaces(data,q);
        }catch{unavailable=true;}
      }
      if(unavailable&&!local.length&&!saved.length)throw Object.assign(Error('Place search is temporarily unavailable. Please try again.'),{status:503});
      const result={places:mergePlaces([saved,local,remote],q),source:[...saved.length?['Saved city landmarks']:[],...local.length?[restaurantSource]:[],...exact||directoryOnly?[]:['Photon / OpenStreetMap']].join(' · '),restaurantDataUpdatedAt:dataUpdatedAt,...directoryOnly?{complete:exact}:null,...unavailable?{partial:true}:{}};
      if(cache.size>=100)cache.delete(cache.keys().next().value);
      cache.set(key,{result,until:now()+(unavailable?15000:300000)});return result;
    })().finally(()=>pending.delete(key));
    pending.set(key,job);return job;
  };
}
