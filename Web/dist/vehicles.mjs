import {icon} from './icons.mjs';
import {subwayBullet,subwayStyle} from './subway-ui.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const age=v=>Math.max(0,Math.floor(Date.now()/1000-v.reportedAtSeconds));
const color=v=>/^[0-9a-f]{6}$/i.test(v.routeColor)?'#'+v.routeColor:v.mode==='bus'?'#2d5bff':'#25815f';
const clock=value=>new Date(value).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'});
export function attachVehicleMap({map,L,api,getRoute,onSnapshot=()=>{}}){
  const layer=L.layerGroup().addTo(map),markers=new Map(),control=document.createElement('section');
  control.className='vehicle-map-control';control.setAttribute('aria-label','Live vehicle map layers');
  control.innerHTML=`<button class="vehicle-layer-title" aria-expanded="false">${icon('activity')} Live vehicles <span>⌄</span></button><div class="vehicle-layer-options" hidden><label><input type="checkbox" name="bus" checked>Bus GPS</label><label><input type="checkbox" name="subway" checked>Train station estimates</label><label><input type="checkbox" name="routeOnly">Selected route lines</label><p>Subway markers are at reported or next stations. Exact positions between stations are unavailable.</p></div><p class="vehicle-map-status" role="status">Checking vehicle reports…</p><button class="vehicle-expand">Expand live map</button>`;
  document.querySelector('#app').append(control);
  const status=control.querySelector('.vehicle-map-status'),options=control.querySelector('.vehicle-layer-options'),title=control.querySelector('.vehicle-layer-title');
  let controller,requestID=0,moveTimer,snapshot,suspended=false,view='directions',line='';
  const modeEnabled=mode=>view==='directions'?control.querySelector(`[name="${mode}"]`).checked:mode===view;
  function clear(){
    controller?.abort();requestID++;snapshot=null;layer.clearLayers();markers.clear();
  }
  function markerIcon(vehicle){
    const gps=vehicle.accuracy==='gps',compact=map.getZoom()<15,heading=vehicle.bearing==null?'':`<span class="vehicle-heading" aria-hidden="true" style="transform:rotate(${Number(vehicle.bearing)}deg)"><svg viewBox="0 0 16 16"><path d="M8 1 14 14 8 11 2 14Z"/></svg></span>`;
    if(view==='subway'){
      const style=subwayStyle(vehicle.line,vehicle.routeColor);
      const html=`<div class="subway-train" style="--vehicle-color:${style.color}">${subwayBullet(vehicle.line,vehicle.routeColor)}${heading}</div>`;
      return L.divIcon({className:'vehicle-pin-container',html,iconSize:[1,1],iconAnchor:[0,0]});
    }
    const content=(compact?(vehicle.mode==='bus'?icon('bus'):`<b>${esc(vehicle.line)}</b>`):`${icon(vehicle.mode)}<b>${esc(vehicle.line)}</b>`)+heading;
    const html=`<div class="vehicle-pin ${gps?'gps':'station-estimate'} ${compact?'compact':''}" style="--vehicle-color:${color(vehicle)}">${content}</div>`;
    return L.divIcon({className:'vehicle-pin-container',html,iconSize:[1,1],iconAnchor:[0,0]});
  }
  function popup(vehicle){
    return `<div class="vehicle-popup"><h3>${vehicle.mode==='bus'?'Bus':'Train'} ${esc(vehicle.line)}</h3><strong>${vehicle.accuracy==='gps'?'Reported GPS':'Station estimate'}</strong><p>${esc(vehicle.status)}</p>${vehicle.directionLabel?`<p>${esc(vehicle.directionLabel)}</p>`:''}<p>Reported ${clock(vehicle.reportedAt)} · ${age(vehicle)}s ago</p>${vehicle.accuracy==='gps'?'':'<p>This marker uses the reported or next station, not an exact position between stations.</p>'}<small>${esc(vehicle.source)}</small></div>`;
  }
  function render(){
    const visible=(snapshot?.vehicles||[]).filter(v=>age(v)<=90&&modeEnabled(v.mode)),ids=new Set(visible.map(v=>v.id));
    for(const [id,marker] of markers)if(!ids.has(id)){layer.removeLayer(marker);markers.delete(id);}
    for(const v of visible){
      const point=[v.coordinate.latitude,v.coordinate.longitude],label=`${v.mode==='bus'?'Bus':'Train'} ${v.line}, ${v.accuracy==='gps'?'reported GPS':'station estimate'}${v.directionLabel?', '+v.directionLabel:''}`;
      let marker=markers.get(v.id);
      if(!marker){marker=L.marker(point,{icon:markerIcon(v),title:label,alt:label,zIndexOffset:v.mode==='bus'?400:300}).bindPopup(popup(v),{maxWidth:290}).addTo(layer);markers.set(v.id,marker);}
      else{marker.setLatLng(point);marker.setIcon(markerIcon(v));marker.setPopupContent(popup(v));}
      marker.getElement()?.setAttribute('aria-label',label);
    }
    if(!snapshot)return;
    const buses=visible.filter(v=>v.mode==='bus').length,trains=visible.length-buses;
    let text=`${buses} bus GPS · ${trains} train station estimates`;
    const bus=snapshot.feedStatus.busVehicles;
    if(modeEnabled('bus')&&bus?.configured===false)text+=' · Bus key needed';
    else if(modeEnabled('bus')&&bus?.stale)text+=' · Bus GPS unavailable';
    if(snapshot.truncated)text+=' · Zoom in for more';
    status.textContent=text;
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
  setInterval(refresh,15000);setInterval(render,5000);refresh();
  return {refresh,
    setView(value){
      view=value;line='';control.hidden=view!=='directions';
      document.body.classList.remove('vehicle-explore');control.querySelector('.vehicle-expand').textContent='Expand live map';
      clear();refresh();
    },
    setLine(value){line=value;clear();refresh();},
    setSuspended(value){
      if(suspended===value)return;
      suspended=value;
      if(value)clear();
      else refresh();
    }
  };
}
