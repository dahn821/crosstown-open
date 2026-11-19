import {walkingSpeed} from './walking.mjs';

export const classicCyclingSpeed=4.5;
const lowAssistSpeed=classicCyclingSpeed*1.2;
const rentalSetupSeconds=120;
const maxPickupWalkSeconds=600;
const searchPoint=(name,coordinate)=>({label:name,location:{coordinate}});
const stationID=place=>String(place.vehicleRentalStation?.stationId||'').split(':').at(-1);
const street=(mode)=>({direct:[mode],directOnly:true});
const seconds=legs=>legs.reduce((sum,leg)=>sum+leg.duration,0);

export function freshBikeStation(station,now=Date.now()){
  return !!station&&now-station.reportedAt<=300000&&station.reportedAt<=now+120000;
}

export function lowAssistPickup(station){
  return freshBikeStation(station)&&station.isRenting&&station.classicBikes===0&&station.ebikes>0;
}

export function bikeStationSnapshot(store){
  const status=store.status().bikes;
  if(!store.gbfs.get('station_status'))throw Object.assign(Error('Current Citi Bike reports are unavailable.'),{status:503});
  return {...status,stationCount:status.stations,stations:store.bikeStations()};
}

// A personal pace comes from observed dock-to-dock time. It already includes
// typical signals and stops along the street, so use distance to estimate time.
export function rentalDuration(leg,preferences){
  const lowAssist=leg.bikeRideType==='lowAssist';
  const classicPace=preferences.classicBikePaceMph;
  const pace=lowAssist?(preferences.lowAssistBikePaceMph??(classicPace==null?null:classicPace*1.2)):classicPace;
  if(pace==null||!(leg.distance>0))return leg.duration;
  const pushed=Math.min(leg.distance,leg.walkBikeMeters??(leg.steps||[]).reduce((sum,step)=>sum+(step.walkingBike?(step.distance||0):0),0));
  return Math.round((leg.distance-pushed)/(pace*0.44704)+pushed/walkingSpeed(preferences)+rentalSetupSeconds);
}

const pushedMeters=leg=>leg.mode==='WALK'||leg.walkingBike===true?leg.distance||0:(leg.steps||[]).reduce((sum,step)=>sum+(step.walkingBike?(step.distance||0):0),0);
export function rentalLeg(parts,from,to,geometry,bikeRideType){
  return {
    mode:'BICYCLE',rentedBike:true,bikeRideType,duration:seconds(parts)+rentalSetupSeconds,
    distance:parts.reduce((sum,leg)=>sum+(leg.distance||0),0),
    walkBikeMeters:parts.reduce((sum,leg)=>sum+pushedMeters(leg),0),
    from,to,coordinates:parts.flatMap(geometry),
    steps:parts.flatMap(leg=>(leg.steps||[]).map(step=>({...step,walkingBike:leg.mode==='WALK'||leg.walkingBike||step.walkingBike})))
  };
}

// Reuse the classic route's return dock and walk so the comparison includes
// both walking legs, and only new pickup paths and the e-bike leg need routing.
export async function lowAssistTrip(raw,request,store,{search,distance,geometry,pickupLimit}){
  const p=request.preferences;
  if(p.bikeSource!=='citiBike'||!p.citiBikeMember||!p.modes.includes('bike')||store.status().bikes.stale)return null;
  const stations=store.bikeStations(),byId=new Map(stations.map(station=>[station.id,station]));
  const reference=raw.flatMap(trip=>{
    const rides=trip.legs.filter(leg=>leg.mode!=='WALK');
    if(rides.length!==1||rides[0].mode!=='BICYCLE'||!rides[0].rentedBike)return [];
    const bike=rides[0],pickup=byId.get(stationID(bike.from)),drop=byId.get(stationID(bike.to));
    if(!freshBikeStation(pickup)||!pickup.isRenting||!(pickup.classicBikes>0)||!freshBikeStation(drop)||!drop.isReturning||!(drop.docks>0))return [];
    const riding=rentalDuration(bike,p);
    return [{trip,bike,drop,riding,seconds:seconds(trip.legs)-bike.duration+riding}];
  }).sort((a,b)=>a.seconds-b.seconds)[0];
  if(!reference||reference.riding<=20*60+rentalSetupSeconds)return null;

  const {origin,depart,arriveBy}=request,drop=reference.drop;
  const instant=arriveBy??depart,asPoint=station=>searchPoint(station.name,station.coordinate);
  const candidates=stations.filter(station=>station.id!==drop.id&&lowAssistPickup(station))
    .map(station=>({station,distance:distance(origin.coordinate,station.coordinate)}))
    .filter(candidate=>candidate.distance<maxPickupWalkSeconds*walkingSpeed(p))
    .sort((a,b)=>a.distance-b.distance).slice(0,pickupLimit);
  const accesses=await Promise.allSettled(candidates.map(async({station,distance})=>{
    if(distance<3)return {station,legs:[],seconds:0};
    const [access]=await search(searchPoint(origin.name,origin.coordinate),asPoint(station),street('WALK'),p,instant,arriveBy!=null);
    return access?.legs.every(leg=>leg.mode==='WALK')?{station,legs:access.legs,seconds:seconds(access.legs)}:null;
  }));
  const access=accesses.flatMap(result=>result.status==='fulfilled'&&result.value&&result.value.seconds<maxPickupWalkSeconds?[result.value]:[])
    .sort((a,b)=>a.seconds-b.seconds)[0];
  if(!access){
    const failure=accesses.find(result=>result.status==='rejected');
    if(failure)throw failure.reason;
    return null;
  }
  const [ride]=await search(asPoint(access.station),asPoint(drop),street('BICYCLE'),p,instant,arriveBy!=null,{cyclingSpeed:lowAssistSpeed});
  if(!ride?.legs.some(leg=>leg.mode==='BICYCLE'))return null;
  const pickupPlace={name:access.station.name,lat:access.station.coordinate.latitude,lon:access.station.coordinate.longitude,vehicleRentalStation:{stationId:'citibike:'+access.station.id}};
  const bike=rentalLeg(ride.legs,pickupPlace,reference.bike.to,geometry,'lowAssist');
  const egress=reference.trip.legs.slice(reference.trip.legs.indexOf(reference.bike)+1),legs=[...access.legs,bike,...egress];
  return {legs,classicComparisonSeconds:reference.seconds};
}
