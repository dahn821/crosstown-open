import {icon} from './icons.mjs';
import {subwayBullet,subwayStyle} from './subway-ui.mjs';
import {trainIsDue,vehicleReports,vehicleSource} from './transit-arrivals.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color=v=>/^[0-9a-f]{6}$/i.test(v.routeColor)?'#'+v.routeColor:v.mode==='bus'?'#2d5bff':'#25815f';
export function attachVehicleMap({map,L,api,getRoute,onSelect,onSnapshot=()=>{}}){
  const layer=L.layerGroup().addTo(map),markers=new Map(),control=document.createElement('section');
  control.className='vehicle-map-control';control.setAttribute('aria-label','Live vehicle map layers');
  control.innerHTML=`<button class="vehicle-layer-title" aria-expanded="false">${icon('activity')} Live vehicles <span>⌄</span></button><div class="vehicle-layer-options" hidden><label><input type="checkbox" name="bus" checked>Bus GPS</label><label><input type="checkbox" name="subway" checked>Train station reports and estimates</label><label><input type="checkbox" name="routeOnly">Selected route lines</label><p>Tap a vehicle to follow its upcoming stops.</p></div><p class="vehicle-map-status" role="status">Checking vehicle reports…</p><button class="vehicle-expand">Expand live map</button>`;
  document.querySelector('#app').append(control);
  const status=control.querySelector('.vehicle-map-status'),options=control.querySelector('.vehicle-layer-options'),title=control.querySelector('.vehicle-layer-title');
  let controller,requestID=0,moveTimer,snapshot,suspended=false,view='directions',line='';
  let predictions=[],reports=[],selectedTrip=null,trackingReport=null;
  const modeEnabled=mode=>view==='directions'?control.querySelector(`[name="${mode}"]`).checked:mode===view;
  function clear(){
    controller?.abort();requestID++;snapshot=null;layer.clearLayers();markers.clear();
  }
  function markerIcon(vehicle){
    const gps=vehicle.accuracy==='gps',compact=map.getZoom()<15,heading=vehicle.bearing==null?'':`<span class="vehicle-heading" aria-hidden="true" style="transform:rotate(${Number(vehicle.bearing)}deg)"><svg viewBox="0 0 16 16"><path d="M8 1 14 14 8 11 2 14Z"/></svg></span>`;
    const dueCount=vehicle.group?vehicle.group.filter(v=>v.due).length:Number(vehicle.due);
    const namedCount=vehicle.group?.length||1;
    const count=dueCount||namedCount;
    const stack=count>1?`<small class="bus-pin-count" aria-hidden="true">${count}</small>`:'';
    const due=dueCount===0||view!=='subway'?'':`<span class="train-due">Due${dueCount>1?' ×'+dueCount:''}</span>`;
    const selected=selectedTrip&&(vehicle.trackingId===selectedTrip||vehicle.group?.some(v=>v.trackingId===selectedTrip));
    const flags=`${selected?'vehicle-selected':''} ${vehicle.accuracy==='prediction-stop'?'vehicle-prediction':''}`;
    if(view==='subway'){
      const style=subwayStyle(vehicle.line,vehicle.routeColor);
      const html=`<div class="subway-train ${flags}" style="--vehicle-color:${style.color}">${subwayBullet(vehicle.line,vehicle.routeColor)}${heading}${due||stack}</div>`;
      return L.divIcon({className:'vehicle-pin-container',html,iconSize:[1,1],iconAnchor:[0,0]});
    }
    const content=(compact?(vehicle.mode==='bus'?icon('bus'):`<b>${esc(vehicle.line)}</b>`):`${icon(vehicle.mode)}<b>${esc(vehicle.line)}</b>`)+heading+stack;
    const html=`<div class="vehicle-pin ${gps?'gps':'station-estimate'} ${compact?'compact':''} ${flags}" style="--vehicle-color:${color(vehicle)}">${content}${due}</div>`;
    return L.divIcon({className:'vehicle-pin-container',html,iconSize:[1,1],iconAnchor:[0,0]});
  }
  const label=v=>`${v.mode==='bus'?'Bus':'Train'} ${v.line}${v.directionLabel?', '+v.directionLabel:''}${v.due?', due':''}`;
  function openReport(vehicle){
    if(vehicle.trackingId){onSelect(vehicle);return;}
    L.popup({maxWidth:290}).setLatLng([vehicle.coordinate.latitude,vehicle.coordinate.longitude])
      .setContent(`<div class="vehicle-popup"><h3>${esc(label(vehicle))}</h3><strong>${vehicleSource(vehicle)}</strong><p>${esc(vehicle.status)}</p><p>Upcoming stops unavailable.</p></div>`).openOn(map);
  }
  function selectMarker(vehicle){
    if(!vehicle.group){openReport(vehicle);return;}
    const list=document.createElement('div');list.className='vehicle-popup vehicle-picker';
    list.innerHTML=`<h3>Choose a ${vehicle.mode==='subway'?'train':'bus'}</h3>`;
    for(const item of vehicle.group){
      const button=document.createElement('button');
      button.type='button';
      button.innerHTML=`<strong>${esc(label(item))}</strong><small>${esc(item.status)} · ${vehicleSource(item)}</small>`;
      button.addEventListener('click',()=>{map.closePopup();openReport(item);});
      list.append(button);
    }
    L.popup({maxWidth:290}).setLatLng([vehicle.coordinate.latitude,vehicle.coordinate.longitude]).setContent(list).openOn(map);
  }
  function displayedVehicles(vehicles){
    const cells=new Map();
    for(const vehicle of vehicles){
      const {latitude,longitude}=vehicle.coordinate;
      let cell=vehicle.id;
      if(vehicle.mode==='subway')cell=`station/${latitude.toFixed(5)}/${longitude.toFixed(5)}`;
      else if(map.getZoom()<15){
        const p=map.latLngToContainerPoint([latitude,longitude]);
        cell=`bus/${Math.floor(p.x/35)}/${Math.floor(p.y/35)}`;
      }
      if(!cells.has(cell))cells.set(cell,[]);
      cells.get(cell).push(vehicle);
    }
    return [...cells].map(([cell,items])=>{
      if(items.length===1)return items[0];
      const first=items.find(v=>v.trackingId===selectedTrip)||items.find(v=>v.due)||items[0];
      return {...first,id:cell,group:items};
    });
  }
  function render(){
    if(suspended||document.hidden)return;
    const now=Date.now();
    const current=snapshot?.vehicles||[];
    const currentReport=trackingReport&&current.find(v=>v.trackingId===trackingReport.trackingId);
    const positions=trackingReport&&(!currentReport||Date.parse(currentReport.reportedAt)<Date.parse(trackingReport.reportedAt))?
      [...current.filter(v=>v.trackingId!==trackingReport.trackingId),trackingReport]:current;
    reports=vehicleReports(positions,predictions,now).filter(v=>modeEnabled(v.mode))
      .map(v=>({...v,due:v.mode==='subway'&&trainIsDue(v,now)&&(v.accuracy==='prediction-stop'||v.positionReport?.stopId===v.nextStop?.stopId)}));
    const visible=displayedVehicles(reports),ids=new Set(visible.map(v=>v.id));
    for(const [id,marker] of markers)if(!ids.has(id)){layer.removeLayer(marker);markers.delete(id);}
    for(const v of visible){
      const point=[v.coordinate.latitude,v.coordinate.longitude];
      const title=v.group?`${v.group.length} ${v.mode==='bus'?'nearby buses':'trains at this marker'}${v.group.some(item=>item.due)?', due arrivals':''}`:`${label(v)}, ${vehicleSource(v)}`;
      const offset=(v.trackingId&&v.trackingId===selectedTrip?1000:0)+(v.due?600:v.mode==='bus'?400:300);
      const icon=markerIcon(v);
      let marker=markers.get(v.id);
      if(!marker){
        marker=L.marker(point,{icon,title,alt:title,zIndexOffset:offset,bubblingMouseEvents:false}).addTo(layer);
        marker.on('click',()=>selectMarker(marker.vehicle));
        markers.set(v.id,marker);
      }else{
        if(!marker.getLatLng().equals(point))marker.setLatLng(point);
        if(marker.options.icon.options.html!==icon.options.html)marker.setIcon(icon);
        if(marker.options.zIndexOffset!==offset)marker.setZIndexOffset(offset);
      }
      marker.vehicle=v;
      const node=marker.getElement();
      if(node&&node.getAttribute('aria-label')!==title){node.title=title;node.setAttribute('aria-label',title);}
    }
    if(!snapshot)return;
    const buses=reports.filter(v=>v.mode==='bus').length,trains=reports.length-buses;
    let text=`${buses} bus GPS · ${trains} train reports and estimates`;
    const bus=snapshot.feedStatus.busVehicles;
    if(modeEnabled('bus')&&bus?.configured===false)text+=' · Bus key needed';
    else if(modeEnabled('bus')&&bus?.stale)text+=' · Bus GPS unavailable';
    if(snapshot.truncated)text+=' · Zoom in for more';
    if(status.textContent!==text)status.textContent=text;
  }
  async function refresh(){
    if(document.hidden||suspended||view==='bike')return;
    const modes=['bus','subway'].filter(modeEnabled);
    if(!modes.length){clear();status.textContent='Vehicle layers hidden';return;}
    const id=++requestID;controller?.abort();controller=new AbortController();
    const b=map.getBounds(),params=new URLSearchParams({bbox:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(','),modes:modes.join(',')});
    const route=getRoute(),lines=[...new Set(route?.legs.map(l=>l.line).filter(Boolean)||[])];
    const routeOnly=control.querySelector('[name="routeOnly"]');routeOnly.disabled=!lines.length;
    if(view==='subway')params.set('network','1');
    if(view!=='directions'&&line)params.set('lines',line);
    else if(view==='directions'&&routeOnly.checked&&lines.length)params.set('lines',lines.join(','));
    try{
      const result=await api('/vehicles?'+params,{signal:controller.signal});if(id!==requestID)return;
      snapshot=result;render();onSnapshot(view,result);
    }catch(e){if(id!==requestID||e.name==='AbortError')return;clear();onSnapshot(view,null);status.textContent='Vehicle reports unavailable. Refresh the map to try again.';}
  }
  title.addEventListener('click',()=>{options.hidden=!options.hidden;title.setAttribute('aria-expanded',!options.hidden);});
  control.addEventListener('change',refresh);
  control.querySelector('.vehicle-expand').addEventListener('click',event=>{
    const expanded=document.body.classList.toggle('vehicle-explore');event.currentTarget.textContent=expanded?'Back to directions':'Expand live map';
    map.invalidateSize();refresh();
  });
  L.DomEvent.disableClickPropagation(control);L.DomEvent.disableScrollPropagation(control);
  map.on('moveend',()=>{clearTimeout(moveTimer);moveTimer=setTimeout(refresh,250);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(refresh,15000);setInterval(render,1000);refresh();
  return {refresh,
    setView(value){
      view=value;line='';predictions=[];control.hidden=view!=='directions';
      document.body.classList.remove('vehicle-explore');control.querySelector('.vehicle-expand').textContent='Expand live map';
      clear();refresh();
    },
    setLine(value){line=value;clear();refresh();},
    setStationPredictions(rows){predictions=rows;render();},
    setSelectedTrip(id){selectedTrip=id;trackingReport=null;render();},
    setTrackingReport(report){trackingReport=report?.trackingId===selectedTrip?report:null;render();},
    findTrip(id){return reports.find(vehicle=>vehicle.trackingId===id);},
    setSuspended(value){
      if(suspended===value)return;
      suspended=value;
      if(value)clear();
      else refresh();
    }
  };
}
