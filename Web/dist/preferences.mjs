export const defaults=()=>({priority:'fastest',modes:['walk','bike','subway','bus'],maxFareCents:1500,maxWalkingMinutes:30,maxBikingMinutes:45,maxTransfers:2,citiBikeMember:true,bikeSource:'citiBike',walkingPace:'brisk',timeWeight:70,costWeight:25,outsideWeight:25,undergroundWeight:0,requireLiveTransit:true});
export const labels={fastest:'Fastest',cost:'Spend less',aboveGround:'Above ground',sheltered:'Less outside',custom:'My mix'};
export const bikePaceKeys=['classicBikePaceMph','lowAssistBikePaceMph'];
export function bikePaces(raw){
  return Object.fromEntries(bikePaceKeys.map(key=>{
    const value=Number(raw?.[key]);
    return [key,Number.isFinite(value)&&value>=4&&value<=18?Math.round(value*10)/10:null];
  }));
}
export function linkedBikePaces(hash){
  const values=new URLSearchParams(hash.slice(1)).get('bike-pace')?.split(',');
  if(values?.length!==2)return null;
  const paces=bikePaces(Object.fromEntries(bikePaceKeys.map((key,index)=>[key,values[index]])));
  return bikePaceKeys.every(key=>paces[key]!=null)?paces:null;
}
export function routeTitle(route){const names=[];for(const l of route.legs.filter(l=>l.mode!=='walk')){const name=l.mode==='bike'?(l.bikeSource==='ownBike'?'My bike':l.bikeRideType==='lowAssist'?'Low-assist Citi Bike':'Citi Bike'):l.lineOptions?.map(option=>option.line).join('/')||l.line||l.mode;if(names.at(-1)!==name)names.push(name);}return names.join(' → ')||'Walk';}
