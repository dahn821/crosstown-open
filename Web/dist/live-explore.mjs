import {icon} from './icons.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const point=coordinate=>[coordinate.latitude,coordinate.longitude];
const cityCenter=[40.757,-73.977];
const titles={subway:'Subway arrivals',bus:'Bus arrivals',bike:'Citi Bike docks'};
const railColor=value=>/^[0-9a-f]{6}$/i.test(value)?'#'+value:'#248365';
const clock=value=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}):'';
const remaining=value=>{
  const seconds=(Date.parse(value)-Date.now())/1000;
  return seconds< -30?'Departed':seconds<60?'Due':Math.ceil(seconds/60)+' min';
};
const stationID=departure=>departure.mode==='subway'?departure.stop.id.replace(/[NS]$/,''):departure.stop.id;
const usable=station=>Date.now()-station.reportedAt<=300000&&station.reportedAt<=Date.now()+120000;
const dockColor=(station,stale)=>stale||!usable(station)||!station.isRenting?'#667683':station.classicBikes===0&&station.ebikes>0?'#6749c7':station.bikes>0?'#117959':'#bd4425';
const dockCounts=station=>`${station.isRenting?`${station.classicBikes??'?'} classic · ${station.ebikes??'?'} e-bikes`:'Pickup paused'} · ${station.isReturning?station.docks+' open docks':'Returns paused'}`;
const badge=departure=>`<span class="live-line" style="--line-color:${departure.mode==='bus'?'#2262aa':railColor(departure.routeColor)}">${esc(departure.line)}</span>`;

export function attachLiveExplore({map,L,api,vehicles,getLocation}){
  const panel=document.querySelector('#live-explore'),body=panel.querySelector('.live-board'),count=panel.querySelector('.live-count');
  const heading=panel.querySelector('.live-title'),status=panel.querySelector('.live-map-report'),select=panel.querySelector('#live-line-filter');
  const detail=panel.querySelector('.live-detail'),toggle=panel.querySelector('[data-live-toggle]');
  const lines=L.layerGroup().addTo(map),stops=L.layerGroup().addTo(map),dockLayer=L.layerGroup().addTo(map);
  const dockRenderer=L.canvas({padding:.2});
  let view='directions',data,network,focused,selectedLine='',pending,moveTimer,failure='',lineOptionsKey='';

  function showExpanded(expanded){
    detail.hidden=!expanded;
    toggle.setAttribute('aria-expanded',String(expanded));
  }
  function updateLines(){
    const entries=[...new Set([selectedLine,...(data?.departures||[]).map(d=>d.line),...(network?.segments||[]).map(s=>s.line)].filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    const key=entries.join('|');
    if(key!==lineOptionsKey){
      lineOptionsKey=key;
      select.innerHTML='<option value="">All lines</option>'+entries.map(line=>`<option value="${esc(line)}">${esc(line)}</option>`).join('');
    }
    select.value=selectedLine;
  }
  function focusStation(station){
    focused=station;
    showExpanded(true);
    if(view==='bike')renderDocks();
    else{data=null;renderBoard();queueBoard();}
    const target=point(station.coordinate);
    if(!map.getBounds().pad(-.20).contains(target))map.panTo(target);
  }
  function renderDocks(){
    dockLayer.clearLayers();
    if(!data)return;
    const bounds=map.getBounds(),center=map.getCenter(),local=data.stations.filter(s=>bounds.contains(point(s.coordinate)));
    const near=local.slice().sort((a,b)=>center.distanceTo(point(a.coordinate))-center.distanceTo(point(b.coordinate))).slice(0,10);
    const stale=data.stale||Date.now()-Date.parse(data.sourceTimestamp)>300000;
    const filtered=focused?data.stations.filter(station=>station.id===focused.id):near;
    count.textContent=`${local.length} in view · ${data.stations.length.toLocaleString()} mapped`;
    status.textContent=failure||(stale?'Dock reports are stale.':`Live dock reports · ${clock(data.sourceTimestamp)}`);
    for(const station of local){
      const color=dockColor(station,stale),active=focused?.id===station.id;
      const radius=active?10:Math.max(3,Math.min(8,map.getZoom()-8));
      L.circleMarker(point(station.coordinate),{renderer:dockRenderer,radius,color:'#fff',weight:active?3:1.5,fillColor:color,fillOpacity:1})
        .bindTooltip(esc(station.name)).on('click',()=>focusStation(station)).addTo(dockLayer);
    }
    body.innerHTML=(focused?'<button class="live-back" data-live-back>‹ Nearby docks</button>':'')+
      (filtered.length?filtered.map(station=>`<button class="live-item live-dock" data-live-station="${esc(station.id)}"><span class="dock-dot" style="--dock-color:${dockColor(station,stale)}"></span><span><strong>${esc(station.name)}</strong><small>${esc(dockCounts(station))}${usable(station)?'':' · stale report'}</small></span></button>`).join(''):'<p class="live-empty">Pan to a neighborhood to find docks.</p>');
  }
  function renderStops(){
    stops.clearLayers();
    if(map.getZoom()<12)return;
    const stationList=network?.stations||[...new Map((data?.departures||[]).filter(d=>!selectedLine||d.line===selectedLine).map(d=>[stationID(d),{...d.stop,id:stationID(d)}])).values()];
    for(const station of stationList){
      const pos=point(station.coordinate);
      if(!map.getBounds().contains(pos))continue;
      const active=focused?.id===station.id;
      L.circleMarker(pos,{radius:active?7:5,color:view==='bus'?'#2262aa':'#195347',weight:2,fillColor:active?'#c5e3ff':'#fff',fillOpacity:1})
        .bindTooltip(esc(station.name)).on('click',()=>focusStation(station)).addTo(stops);
    }
  }
  function renderBoard(){
    updateLines();
    renderStops();
    const rows=(data?.departures||[]).filter(d=>(!selectedLine||d.line===selectedLine)&&Date.parse(d.departureTime)>Date.now()-30000);
    count.textContent=focused?.name||(data?`${new Set(rows.map(stationID)).size} stops near map center`:'Pan to a stop or choose a line');
    const blocked=view==='bus'&&data?.feedStatus?.bus?.configured===false;
    const stale=data&&(view==='bus'?data.feedStatus.bus.stale:data.feedStatus.subway.every(feed=>feed.stale));
    const groups=new Map();
    for(const departure of rows){
      const id=stationID(departure),key=focused?`${departure.line}|${departure.direction||''}`:`${id}|${departure.line}|${departure.direction||''}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(departure);
    }
    const contents=[...groups.values()].slice(0,18).map(group=>{
      const d=group[0],times=group.slice(0,3).map(item=>`<time datetime="${esc(item.departureTime)}" data-live-time="${esc(item.departureTime)}">${remaining(item.departureTime)}</time>`).join('');
      const label=`<span><strong>${esc(d.stop.name)}</strong><small>${esc(d.direction||'Live MTA prediction')}</small></span>`;
      const content=badge(d)+label+`<span class="live-times">${times}</span>`;
      return focused?`<div class="live-item">${content}</div>`:`<button class="live-item" data-live-station="${esc(stationID(d))}">${content}</button>`;
    }).join('');
    body.innerHTML=(focused?'<button class="live-back" data-live-back>‹ Nearby stops</button>':'')+
      (blocked?'<p class="live-empty">Bus Time needs a connection.</p><button class="text-button" data-action="sources">Open Sources</button>':contents||
       `<p class="live-empty">${esc(failure||(stale?'Current MTA predictions are unavailable.':data?'No upcoming departures reported here.':'Checking departures…'))}</p>`);
  }
  async function refresh(){
    if(view==='directions'||document.hidden)return;
    pending?.abort();
    const controller=new AbortController();pending=controller;
    const where=focused?.coordinate||{latitude:map.getCenter().lat,longitude:map.getCenter().lng};
    const query=new URLSearchParams({lat:where.latitude.toFixed(4),lon:where.longitude.toFixed(4),mode:view});
    if(focused)query.set('stop',focused.id);
    try{
      const result=await api(view==='bike'?'/bike-stations':'/transit?'+query,{signal:controller.signal});
      if(pending!==controller)return;
      data=result;failure='';
    }catch(error){
      if(pending!==controller||error.name==='AbortError')return;
      failure=view==='bike'?'Dock reports unavailable. Try refreshing.':'Departure reports unavailable here.';
      if(view!=='bike')data=null;
    }
    if(view==='bike'){
      if(data)renderDocks();
      else{status.textContent=failure;body.innerHTML=`<p class="live-empty">${esc(failure)}</p>`;}
    }else renderBoard();
  }
  function queueBoard(){
    clearTimeout(moveTimer);moveTimer=setTimeout(refresh,420);
  }
  function reset(){
    data=null;network=null;focused=null;selectedLine='';failure='';
    pending?.abort();pending=null;clearTimeout(moveTimer);
    lines.clearLayers();stops.clearLayers();dockLayer.clearLayers();
  }
  map.on('moveend',()=>{
    if(view==='bike')renderDocks();
    else if(view!=='directions'&&!focused)queueBoard();
  });
  panel.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button)return;
    if(button.hasAttribute('data-live-toggle'))showExpanded(detail.hidden);
    if(button.hasAttribute('data-live-refresh')){refresh();vehicles.refresh();}
    if(button.hasAttribute('data-live-center')){
      focused=null;const coordinate=getLocation();
      map.setView(coordinate?point(coordinate):cityCenter,15);
      if(view==='bike')renderDocks();else queueBoard();
    }
    if(button.hasAttribute('data-live-back')){
      focused=null;
      if(view==='bike')renderDocks();else{data=null;renderBoard();queueBoard();}
    }
    const id=button.dataset.liveStation;
    if(!id)return;
    const station=view==='bike'?data?.stations.find(item=>item.id===id):data?.departures.find(item=>stationID(item)===id)?.stop;
    if(station)focusStation({...station,id});
  });
  select.addEventListener('change',()=>{
    selectedLine=select.value;network=null;lines.clearLayers();
    vehicles.setLine(selectedLine);renderBoard();
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(refresh,30000);
  setInterval(()=>{
    if(view==='bike'||view==='directions'||document.hidden||detail.hidden)return;
    for(const node of body.querySelectorAll('time[data-live-time]'))node.textContent=remaining(node.dataset.liveTime);
  },1000);

  return {
    setView(next){
      if(next===view)return;
      view=next;reset();
      panel.hidden=view==='directions';panel.dataset.mode=view;
      vehicles.setView(view);
      if(panel.hidden)return;
      heading.textContent=titles[view];
      count.textContent=view==='bike'?'Checking dock availability…':'Checking nearby stops…';
      status.textContent=view==='bike'?'Citi Bike GBFS':view==='bus'?'MTA Bus Time GPS':'MTA station reports · estimated train positions';
      body.innerHTML='<p class="live-empty">Loading live reports…</p>';
      panel.querySelector('.live-filter').hidden=view==='bike';
      panel.querySelector('.live-legend').hidden=view!=='bike';
      updateLines();showExpanded(true);
      refresh();
    },
    vehicleReport(mode,result){
      if(mode!==view||view==='directions'||view==='bike')return;
      network=result?.network;
      lines.clearLayers();
      for(const segment of network?.segments||[]){
        L.polyline(segment.points,{color:railColor(segment.color),weight:selectedLine?4:2.5,opacity:selectedLine?.8:.48,interactive:false}).addTo(lines);
      }
      const qty=result?.vehicles?.length??0,bus=view==='bus';
      status.textContent=result?(bus&&result.feedStatus.busVehicles?.stale?'Bus GPS unavailable':`${qty} ${bus?'bus GPS positions':'train station estimates'}${result.truncated?' · zoom in':''}`):'Vehicle reports unavailable';
      renderStops();updateLines();
    }
  };
}
