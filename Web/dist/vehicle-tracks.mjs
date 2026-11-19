import {icon} from './icons.mjs';
import {subwayBullet,subwayStyle} from './subway-ui.mjs';
import {liveTimeMarkup,updateLiveTimes,vehicleSource} from './transit-arrivals.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const point=coordinate=>[coordinate.latitude,coordinate.longitude];
const clock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'});
const routeColor=vehicle=>vehicle.mode==='bus'?'#2262aa':subwayStyle(vehicle.line,vehicle.routeColor).color;
const serviceName=vehicle=>vehicle.mode==='bus'?'Bus '+vehicle.line:'Train '+subwayStyle(vehicle.line).name;

export function attachVehicleTracking({map,L,api,findTrip,onChange,onReport}){
  const app=document.querySelector('#app'),panel=document.querySelector('#vehicle-tracker');
  const badge=panel.querySelector('.tracker-badge'),heading=panel.querySelector('h2');
  const source=panel.querySelector('.tracker-source'),message=panel.querySelector('.tracker-message');
  const list=panel.querySelector('.tracker-stops'),dismiss=panel.querySelector('[data-close-tracker]');
  const pane=map.createPane('vehicle-route');pane.style.zIndex='420';pane.style.pointerEvents='none';
  const route=L.layerGroup().addTo(map);
  let selected=null,controller,lastPath='',lastStops='',shouldFit=false,returnFocus=null,lastGood=null;

  function draw(trip){
    const paint=routeColor(trip);
    const currentPath=JSON.stringify([trip.segments,trip.stops.map(stop=>[stop.name,stop.coordinate])]);
    if(currentPath!==lastPath){
      lastPath=currentPath;route.clearLayers();
      const paths=trip.segments.filter(segment=>segment.length>=2);
      if(paths.length){
        for(const [color,weight] of [['#fff',10],[paint,6]]){
          L.polyline(paths,{pane:'vehicle-route',color,weight,opacity:1,interactive:false}).addTo(route);
        }
      }
      for(const [index,stop] of trip.stops.entries()){
        if(!stop.coordinate)continue;
        L.circleMarker(point(stop.coordinate),{pane:'vehicle-route',radius:index===0?6:3.5,
          color:paint,weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(route);
      }
    }
    if(!shouldFit)return;
    shouldFit=false;
    const bounds=L.latLngBounds(trip.segments.flat());
    for(const stop of trip.stops)if(stop.coordinate)bounds.extend(point(stop.coordinate));
    if(trip.position?.coordinate)bounds.extend(point(trip.position.coordinate));
    if(!bounds.isValid())return;
    const mapRect=map.getContainer().getBoundingClientRect(),rect=panel.getBoundingClientRect();
    const mobile=matchMedia('(max-width: 700px)').matches;
    map.fitBounds(bounds,{maxZoom:16,animate:false,
      paddingTopLeft:[mobile?26:rect.right-mapRect.left+22,mobile?86:72],
      paddingBottomRight:[34,mobile?mapRect.bottom-rect.top+20:40]});
  }

  function render(trip){
    const vehicle=findTrip(selected.trackingId);
    const report=vehicle||(!trip?selected:null);
    const note=report?[report.status,vehicleSource(report)]:['MTA live arrival predictions'];
    const direction=trip?.direction||report?.directionLabel;
    if(direction&&direction!=='MTA reported heading')note.unshift(direction);
    source.textContent=note.join(' · ');
    if(!trip)return;
    if(trip.status!=='live'){
      lastGood=null;route.clearLayers();lastPath='';lastStops='';list.replaceChildren();
      message.textContent=trip.status==='changed'?'MTA reported a change to this trip.':'Upcoming live stops are unavailable for this trip.';
      return;
    }
    const nextStops=JSON.stringify(trip.stops);
    if(nextStops!==lastStops){
      lastStops=nextStops;
      const scroll=list.scrollTop;
      list.innerHTML=trip.stops.map((stop,index)=>`<li><span class="tracker-stop-dot" aria-hidden="true"></span><span><strong>${esc(stop.name)}</strong><small>${index===0?'Next stop · ':''}${clock.format(new Date(stop.arrivalTime??stop.departureTime))}</small></span>${liveTimeMarkup(stop)}</li>`).join('');
      list.scrollTop=scroll;
    }
    message.textContent=trip.segments.length?'Upcoming stops':'Upcoming stops · Route path unavailable';
    draw(trip);
  }

  async function refresh(){
    if(!selected||document.hidden||controller)return;
    const request=new AbortController();controller=request;
    try{
      const trip=await api('/vehicle-trip?'+new URLSearchParams({id:selected.trackingId}),{signal:request.signal});
      if(controller!==request)return;
      lastGood=trip.status==='live'?trip:null;
      onReport(trip.position||null);
      render(trip);
    }catch(error){
      if(controller!==request||error.name==='AbortError')return;
      const age=Date.now()-Date.parse(lastGood?.reportedAt);
      if(age>=0&&age<=180000)message.textContent='Last MTA predictions · Reconnecting';
      else{
        onReport(null);
        render({status:'unavailable'});
        message.textContent='Live stops unavailable · Retrying';
      }
    }finally{
      if(controller===request)controller=null;
    }
  }

  function clear(){
    controller?.abort();controller=null;selected=null;lastGood=null;
    route.clearLayers();lastPath='';lastStops='';list.replaceChildren();
  }
  function close({focus=false}={}){
    if(!selected)return;
    clear();panel.hidden=true;delete app.dataset.vehicleTracking;
    onChange(null);
    if(focus){
      const fallback=document.querySelector('.map-tabs [aria-pressed="true"]');
      (returnFocus?.isConnected&&returnFocus.getClientRects().length?returnFocus:fallback)?.focus({preventScroll:true});
    }
    returnFocus=null;
  }
  function select(vehicle){
    if(!vehicle.trackingId||selected?.trackingId===vehicle.trackingId)return;
    returnFocus??=document.activeElement;
    clear();
    map.closePopup();selected=vehicle;shouldFit=true;
    badge.innerHTML=vehicle.mode==='subway'?subwayBullet(vehicle.line,vehicle.routeColor):icon('bus');
    panel.style.setProperty('--tracker-color',routeColor(vehicle));
    heading.textContent=serviceName(vehicle);
    message.textContent='Checking upcoming stops…';
    panel.hidden=false;app.dataset.vehicleTracking='true';
    onChange(vehicle.trackingId);
    render();
    dismiss.focus({preventScroll:true});
    refresh();
  }
  dismiss.addEventListener('click',()=>close({focus:true}));
  panel.addEventListener('keydown',event=>{if(event.key==='Escape')close({focus:true});});
  L.DomEvent.disableClickPropagation(panel);L.DomEvent.disableScrollPropagation(panel);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(refresh,15000);
  setInterval(()=>{if(selected&&!document.hidden)updateLiveTimes(panel);},1000);
  return {select,close};
}
