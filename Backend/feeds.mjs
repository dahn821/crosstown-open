import bindings from 'gtfs-realtime-bindings';
import fs from 'node:fs';
const rt=bindings.transit_realtime;
let defaultTripIndex={};
try{defaultTripIndex=JSON.parse(fs.readFileSync(new URL('./data/trip-index.json',import.meta.url),'utf8'));}catch{}

export function canonicalTripId(index,id,date){
  const weekday=(new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T12:00:00Z`).getUTCDay()+6)%7;
  const active=service=>{
    const exception=index.exceptions?.[date]?.[service];if(exception!=null)return exception===1;
    const calendar=index.calendars?.[service];return calendar&&date>=calendar.start&&date<=calendar.end&&calendar.days[weekday]===1;
  };
  return index.trips?.[id]?.find(t=>active(t.service))?.id||null;
}

export const subwayFeeds=['gtfs','gtfs-ace','gtfs-bdfm','gtfs-g','gtfs-jz','gtfs-l','gtfs-nqrw','gtfs-si'];
export const lineFeeds={1:'gtfs',2:'gtfs',3:'gtfs',4:'gtfs',5:'gtfs',6:'gtfs',7:'gtfs','6X':'gtfs','7X':'gtfs',GS:'gtfs',A:'gtfs-ace',C:'gtfs-ace',E:'gtfs-ace',H:'gtfs-ace',FS:'gtfs-ace',B:'gtfs-bdfm',D:'gtfs-bdfm',F:'gtfs-bdfm',M:'gtfs-bdfm',G:'gtfs-g',J:'gtfs-jz',Z:'gtfs-jz',L:'gtfs-l',N:'gtfs-nqrw',Q:'gtfs-nqrw',R:'gtfs-nqrw',W:'gtfs-nqrw',SI:'gtfs-si'};
const asNumber=x=>x==null?0:Number(x.toString());
const epoch=x=>typeof x==='number'?x*1000:typeof x==='string'?Date.parse(x):0;
// Bus Time adds agency prefixes. GTFS's trailing + means SBS; keep it distinct from local service.
export const busID=id=>String(id??'').replace(/^(?:MTA(?:[ _](?:NYCT|MTABC|BUS))?|MTABC|NYCT)[_ :]+/i,'').replace(/\+$/,'-SBS').replace(/[^a-z0-9]/gi,'').toUpperCase();
const bareStopId=id=>String(id).split(':').at(-1);
export class FeedStore {
  constructor({fetcher=fetch,busKey=process.env.MTA_BUS_TIME_KEY||'',tripIndex=defaultTripIndex}={}){
    this.fetcher=fetcher;this.busKey=busKey;this.tripIndex=tripIndex;this.entries=new Map();this.gbfs=new Map();this.pending=new Map();this.lastBikeError=null;
  }
  async get(url,binary=false){const response=await this.fetcher(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Crosstown/0.2 personal NYC trip planner'}});if(!response.ok)throw Error('Provider returned '+response.status);return binary?Buffer.from(await response.arrayBuffer()):response.json();}
  async refreshSubway(name){
    if(!subwayFeeds.includes(name))throw Error('Unknown feed');
    if(this.pending.has(name))return this.pending.get(name);
    const job=(async()=>{
      try{
        const bytes=await this.get('https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F'+name,true),message=rt.FeedMessage.decode(bytes);
        const timestamp=asNumber(message.header.timestamp)*1000;
        if(!this.tripIndex.trips){this.entries.set(name,{bytes,canonicalBytes:bytes,message,mapped:0,sourceTimestamp:timestamp,fetchedAt:Date.now(),error:null});return;}
        const canonical=rt.FeedMessage.toObject(message,{longs:String,enums:Number,bytes:Buffer});let mapped=0;
        for(const entity of canonical.entity||[]){
          const trip=entity.tripUpdate?.trip;if(!trip?.tripId||!trip?.startDate)continue;
          const id=canonicalTripId(this.tripIndex,trip.tripId,trip.startDate);
          if(id){trip.tripId=id;mapped++;}
        }
        const canonicalBytes=Buffer.from(rt.FeedMessage.encode(rt.FeedMessage.fromObject(canonical)).finish());
        this.entries.set(name,{bytes,canonicalBytes,message,mapped,sourceTimestamp:timestamp,fetchedAt:Date.now(),error:null});
      }catch(error){const previous=this.entries.get(name);this.entries.set(name,{...previous,error:error.message});}
    })().finally(()=>this.pending.delete(name));this.pending.set(name,job);return job;
  }
  async refreshBus(){
    if(!this.busKey)return;
    if(this.pending.has('bus'))return this.pending.get('bus');
    const job=(async()=>{
      try{
        const bytes=await this.get('https://gtfsrt.prod.obanyc.com/tripUpdates?key='+encodeURIComponent(this.busKey),true),message=rt.FeedMessage.decode(bytes);
        this.entries.set('bus',{bytes,message,sourceTimestamp:asNumber(message.header.timestamp)*1000,fetchedAt:Date.now(),error:null});
      }catch{this.entries.set('bus',{...this.entries.get('bus'),error:'Bus Time feed could not be refreshed.'});}
    })().finally(()=>this.pending.delete('bus'));
    this.pending.set('bus',job);
    return job;
  }
  async refreshBusVehicles(){
    if(!this.busKey)return;
    if(this.pending.has('busVehicles'))return this.pending.get('busVehicles');
    const job=(async()=>{
      try{
        const bytes=await this.get('https://gtfsrt.prod.obanyc.com/vehiclePositions?key='+encodeURIComponent(this.busKey),true),message=rt.FeedMessage.decode(bytes);
        this.entries.set('busVehicles',{message,sourceTimestamp:asNumber(message.header.timestamp)*1000,fetchedAt:Date.now(),error:null});
      }catch{this.entries.set('busVehicles',{...this.entries.get('busVehicles'),error:'Bus GPS positions could not be refreshed.'});}
    })().finally(()=>this.pending.delete('busVehicles'));this.pending.set('busVehicles',job);return job;
  }
  async refreshBikes(){
    if(this.pending.has('bikes'))return this.pending.get('bikes');
    const job=(async()=>{
      try{
        const discovery=await this.get('https://gbfs.citibikenyc.com/gbfs/gbfs.json'),feeds=(discovery.data.en||Object.values(discovery.data)[0]).feeds;
        const wanted=['station_information','station_status','system_information','vehicle_types','system_pricing_plans'];
        await Promise.all(feeds.filter(f=>wanted.includes(f.name)).map(async f=>{
          const url=new URL(f.url);if(url.protocol!=='https:'||!['gbfs.lyft.com','gbfs.citibikenyc.com'].includes(url.hostname))throw Error('Unexpected GBFS provider');
          this.gbfs.set(f.name,await this.get(url));
        }));
        this.gbfs.set('discovery',discovery);this.bikeFetchedAt=Date.now();this.lastBikeError=null;
      }catch{this.lastBikeError='Citi Bike feed could not be refreshed.';}
    })().finally(()=>this.pending.delete('bikes'));this.pending.set('bikes',job);return job;
  }
  async refreshAll(){await Promise.allSettled([...subwayFeeds.map(name=>this.refreshSubway(name)),this.refreshBikes(),this.refreshBus(),this.refreshBusVehicles()]);}
  freshness(name){
    const e=this.entries.get(name);const age=e?.sourceTimestamp?(Date.now()-e.sourceTimestamp)/1000:null;
    return {name,sourceTimestamp:e?.sourceTimestamp?new Date(e.sourceTimestamp).toISOString():null,fetchedAt:e?.fetchedAt?new Date(e.fetchedAt).toISOString():null,ageSeconds:age==null?null:Math.round(age),stale:age==null||age>180||age< -120,error:e?.error||null,entities:e?.message?.entity?.length||0,mappedTrips:e?.mapped||0};
  }
  status(){
    const status=this.gbfs.get('station_status'),source=epoch(status?.last_updated),age=source?(Date.now()-source)/1000:null;
    return {subway:subwayFeeds.map(name=>this.freshness(name)),bus:{...this.freshness('bus'),configured:Boolean(this.busKey)},busVehicles:{...this.freshness('busVehicles'),configured:Boolean(this.busKey)},bikes:{sourceTimestamp:source?new Date(source).toISOString():null,fetchedAt:this.bikeFetchedAt?new Date(this.bikeFetchedAt).toISOString():null,ageSeconds:age==null?null:Math.round(age),stale:age==null||age>300||age< -120,error:this.lastBikeError,stations:status?.data?.stations?.length||0}};
  }
  bikeStations(){
    const info=this.gbfs.get('station_information')?.data?.stations||[],statuses=new Map((this.gbfs.get('station_status')?.data?.stations||[]).map(s=>[String(s.station_id),s]));
    return info.flatMap(s=>{const live=statuses.get(String(s.station_id));if(!live||!(live.is_installed===true||live.is_installed===1))return[];return [{id:String(s.station_id),name:s.name,coordinate:{latitude:Number(s.lat),longitude:Number(s.lon)},bikes:live.num_bikes_available,classicBikes:live.num_ebikes_available==null?null:Math.max(0,live.num_bikes_available-live.num_ebikes_available),ebikes:live.num_ebikes_available??null,docks:live.num_docks_available,isRenting:live.is_renting===true||live.is_renting===1,isReturning:live.is_returning===true||live.is_returning===1,reportedAt:epoch(live.last_reported),rentalUris:s.rental_uris||{}}];});
  }
  /** Match reachable trains using actual reported stop-to-stop predictions, never invented headways. */
  connection(query){return this.connections(query)[0]||null;}
  connections({line,tripId,fromStop,toStop,readyAt,kind='subway',latestArrival=Infinity,earliestArrival=-Infinity}){
    if(!fromStop||!toStop||(kind==='bus'&&!line))return [];
    const names=kind==='bus'?['bus']:line?[lineFeeds[line]]:subwayFeeds,candidates=[];
    for(const name of names){
    if(!name||this.freshness(name).stale)continue;const e=this.entries.get(name);
    for(const entity of e?.message?.entity||[]){
      const equal=(a,b)=>kind==='bus'?busID(a)===busID(b):String(a)===String(b);
      const update=entity.tripUpdate,trip=update?.trip;if(entity.isDeleted||!update||!trip||(line&&!equal(trip.routeId,line))||(tripId&&trip.tripId!==tripId)||[3,7].includes(trip.scheduleRelationship))continue;
      const stops=update.stopTimeUpdate||[];const fi=stops.findIndex(s=>equal(s.stopId,fromStop));if(fi<0)continue;
      const ti=stops.findIndex((s,i)=>i>fi&&equal(s.stopId,toStop));if(ti<0||[1,2].includes(stops[fi].scheduleRelationship)||[1,2].includes(stops[ti].scheduleRelationship))continue;
      const departure=asNumber(stops[fi].departure?.time||stops[fi].arrival?.time)*1000,arrival=asNumber(stops[ti].arrival?.time||stops[ti].departure?.time)*1000;
      if(departure>=readyAt&&arrival>=departure&&arrival<=latestArrival&&arrival>=earliestArrival)candidates.push({departure,arrival,tripId:trip.tripId,line:trip.routeId,sourceTimestamp:e.sourceTimestamp,feed:name,stopIds:stops.slice(fi,ti+1).filter(s=>![1,2].includes(s.scheduleRelationship)).map(s=>s.stopId)});
    }
    }
    return candidates.sort((a,b)=>Number.isFinite(latestArrival)?b.departure-a.departure||a.arrival-b.arrival:a.arrival-b.arrival);
  }
  departures(stops,now=Date.now(),{mode:focusMode,stop:focusStop}={}){
    const key=(mode,id)=>mode+':'+(mode==='bus'?busID(bareStopId(id)):bareStopId(id));
    const nearby=new Map(),stopByKey=new Map(),found=new Map();
    for(const stop of stops){
      const mode=stop.vehicleMode==='BUS'?'bus':'subway',id=bareStopId(stop.gtfsId);
      if(focusMode&&mode!==focusMode)continue;
      stopByKey.set(key(mode,stop.gtfsId),stop);
      if(focusStop&&(mode==='bus'?busID(id)!==busID(bareStopId(focusStop)):id.replace(/[NS]$/,'')!==bareStopId(focusStop).replace(/[NS]$/,'')))continue;
      nearby.set(key(mode,stop.gtfsId),stop);
    }
    for(const [name,entry] of this.entries){
      if((!subwayFeeds.includes(name)&&name!=='bus')||this.freshness(name).stale)continue;
      const mode=name==='bus'?'bus':'subway';if(mode==='bus'&&!this.busKey)continue;
      for(const entity of entry.message?.entity||[]){
        const update=entity.tripUpdate,trip=update?.trip;if(entity.isDeleted||!trip||[3,7].includes(trip.scheduleRelationship))continue;
        const calls=update.stopTimeUpdate||[];
        for(const [index,call] of calls.entries()){
          if([1,2].includes(call.scheduleRelationship))continue;
          const stop=nearby.get(key(mode,call.stopId)),time=asNumber(call.departure?.time||call.arrival?.time)*1000;
          if(!stop||time<now||time>now+90*60000)continue;
          const route=stop.routes?.find(r=>mode==='bus'?busID(r.shortName)===busID(trip.routeId):r.shortName===trip.routeId);
          const line=route?.shortName||String(trip.routeId||'').replace(/^(?:MTA NYCT|MTABC)_/,'').replace(/\+$/,'-SBS');
          const id=[name,trip.tripId,stop.gtfsId,time].join('|');
          const next=mode==='bus'?stopByKey.get(key(mode,calls[index+1]?.stopId)):null;
          const direction=mode==='subway'?String(call.stopId).endsWith('N')?'Northbound':String(call.stopId).endsWith('S')?'Southbound':'':next?'Toward '+next.name:null;
          found.set(id,{id,mode,line,stop:{id:stop.gtfsId,name:stop.name,neighborhood:'New York City',coordinate:{latitude:stop.lat,longitude:stop.lon},selectable:true},metersAway:stop.distance,departureTime:new Date(time).toISOString(),direction,routeColor:route?.color||null,predictionReportedAt:new Date(entry.sourceTimestamp).toISOString()});
        }
      }
    }
    const counts=new Map(),modeCounts=new Map();return [...found.values()].sort((a,b)=>Date.parse(a.departureTime)-Date.parse(b.departureTime)||a.metersAway-b.metersAway).filter(d=>{const k=d.mode+'|'+d.stop.id+'|'+d.line,n=counts.get(k)||0,m=modeCounts.get(d.mode)||0;if(n>=3||m>=40)return false;counts.set(k,n+1);modeCounts.set(d.mode,m+1);return true;});
  }
}
