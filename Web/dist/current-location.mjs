export const CURRENT_LOCATION_ID='current-location';

const MAX_AGE=30000,MAX_ACCURACY=100;
function usable(position,now){
 const {latitude,longitude,accuracy}=position?.coords||{},age=now-Number(position?.timestamp);
 return Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180&&Number.isFinite(accuracy)&&accuracy>=0&&accuracy<=MAX_ACCURACY&&Number.isFinite(age)&&age>=-10000&&age<=MAX_AGE;
}
function readLocation(geolocation,secure,now){
 return new Promise((resolve,reject)=>{
  if(!secure){reject(Error('Open Crosstown over HTTPS to use your location, or choose a start.'));return;}
  if(!geolocation){reject(Error('This browser cannot get your location. Choose a start.'));return;}
  let settled=false,remaining=2,approximate=false;
  const fail=error=>{
   if(settled)return;
   if(error.code!==1&&--remaining>0)return;
   settled=true;reject(Error(error.code===1?'Allow location access in your browser, or choose a start.':approximate?'Your location is too approximate. Enable precise location or choose a start.':error.code===3?'Getting your location took too long. Try again or choose a start.':'Your location is unavailable. Try again or choose a start.'));
  };
  const success=position=>{
   if(settled)return;
   if(!usable(position,now())){approximate ||= Number(position?.coords?.accuracy)>MAX_ACCURACY;fail({code:2});return;}
   settled=true;resolve(position);
  };
  // Race a quick cached/Wi-Fi fix against GPS. A slow precision request must
  // not hold up a sufficiently accurate first fix. Browser timeouts exclude
  // the time a user spends answering the permission prompt.
  for(const precise of [false,true]){
   if(settled)break;
   try{geolocation.getCurrentPosition(success,fail,{enableHighAccuracy:precise,maximumAge:MAX_AGE,timeout:precise?8000:4000});}catch{fail({code:2});}
  }
 });
}

// Only keep coordinates in memory. Manual address selection can detach from a
// pending acquisition without letting its eventual result change the origin.
export function createLocationSource({geolocation,secure=true,now=Date.now}){
 let position=null,inFlight=null;
 const cached=()=>usable(position,now())?position:null;
 const place=position=>({id:CURRENT_LOCATION_ID,name:'Current location',neighborhood:'Your device location',coordinate:{latitude:position.coords.latitude,longitude:position.coords.longitude},selectable:true});
 return {
  cached(){const value=cached();return value?place(value):null;},
  get(){
   const value=cached();if(value)return Promise.resolve(place(value));
   if(inFlight)return inFlight;
   inFlight=readLocation(geolocation,secure,now).then(value=>{position=value;return place(value);}).finally(()=>{inFlight=null;});
   return inFlight;
  },
  prefetch(){return this.get().catch(()=>null);}
 };
}

// A late GPS result must never replace an address the user chose meanwhile.
export function createCurrentLocationLookup({geolocation,secure=true,source=createLocationSource({geolocation,secure}),onUpdate}){
 let revision=0,inFlight=null;
 return {
  cancel(){revision++;inFlight=null;},
  request(options={}){
   if(inFlight)return inFlight;
   const token=++revision;
   if(!source.cached())onUpdate({status:'loading'},options);
   inFlight=source.get().then(place=>{
    if(token!==revision)return false;
    onUpdate({status:'ready',place},options);return true;
   },error=>{
    if(token!==revision)return false;
    onUpdate({status:'error',message:error.message},options);return false;
   }).finally(()=>{if(token===revision)inFlight=null;});
   return inFlight;
  }
 };
}
