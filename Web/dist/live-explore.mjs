import {icon} from './icons.mjs';
import {subwayBullet,subwayStyle} from './subway-ui.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const point=coordinate=>[coordinate.latitude,coordinate.longitude];
const cityCenter=[40.757,-73.977];
const titles={subway:'Subway arrivals',bus:'Bus arrivals',bike:'Citi Bike docks'};
const clock=value=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}):'';
const remaining=value=>{
  const seconds=(Date.parse(value)-Date.now())/1000;
  return seconds< -30?'Departed':seconds<60?'Due':Math.ceil(seconds/60)+' min';
};
const stationID=departure=>departure.stationId||(departure.mode==='subway'?departure.stop.id.replace(/[NS]$/,''):departure.stop.id);
const usable=station=>Date.now()-station.reportedAt<=300000&&station.reportedAt<=Date.now()+120000;
const dockColor=(station,stale)=>stale||!usable(station)||!station.isRenting?'#667683':station.classicBikes===0&&station.ebikes>0?'#6749c7':station.bikes>0?'#117959':'#bd4425';
const dockCounts=station=>`${station.isRenting?`${station.classicBikes??'?'} classic · ${station.ebikes??'?'} e-bikes`:'Pickup paused'} · ${station.isReturning?station.docks+' open docks':'Returns paused'}`;
const badge=departure=>`<span class="live-line" style="--line-color:#2262aa">${esc(departure.line)}</span>`;
const feet=meters=>meters<30?'At map center':meters<805?`${Math.round(meters*3.28084/25)*25} ft away`:`${(meters/1609.344).toFixed(1)} mi away`;
const arrivalTime=departure=>`<time datetime="${esc(departure.departureTime)}" data-live-time="${esc(departure.departureTime)}">${remaining(departure.departureTime)}</time>`;
const directionOrder=direction=>direction==='Uptown'?0:direction==='Downtown'?1:2;

export function attachLiveExplore({map,L,api,vehicles,getLocation}){
  const panel=document.querySelector('#live-explore'),body=panel.querySelector('.live-board'),count=panel.querySelector('.live-count'),target=document.querySelector('#subway-target');
  const heading=panel.querySelector('.live-title'),status=panel.querySelector('.live-map-report'),select=panel.querySelector('#live-line-filter');
  const detail=panel.querySelector('.live-detail'),toggle=panel.querySelector('[data-live-toggle]');
  const lines=L.layerGroup().addTo(map),stops=L.layerGroup().addTo(map),dockLayer=L.layerGroup().addTo(map);
  const railPane=map.createPane('subway-rails');
  railPane.style.zIndex='390';
  railPane.style.pointerEvents='none';
  const railRenderer=L.canvas({pane:'subway-rails',padding:.2});
  const dockRenderer=L.canvas({padding:.2});
  const subwayLines=new Set();
  let view='directions',data,network,focused,selectedLine='',pending,moveTimer,failure='',lineOptionsKey='';

  function targetPoint(){
    const marker=target.getBoundingClientRect(),container=map.getContainer().getBoundingClientRect();
    return L.point(marker.left+marker.width/2-container.left,marker.top+marker.height/2-container.top);
  }
  function moveStationToTarget(coordinate,zoom=map.getZoom()){
    const offset=targetPoint().subtract(map.getSize().divideBy(2));
    map.setView(map.unproject(map.project(point(coordinate),zoom).subtract(offset),zoom),zoom,{animate:false});
  }
  function showExpanded(expanded){
    detail.hidden=!expanded;
    toggle.setAttribute('aria-expanded',String(expanded));
  }
  function updateLines(){
    const reported=[...(data?.departures||[]).map(d=>d.line),...(network?.segments||[]).map(s=>s.line)];
    if(view==='subway'&&!selectedLine)for(const line of reported)if(line)subwayLines.add(line);
    const entries=[...new Set([selectedLine,...reported,...(view==='subway'?subwayLines:[])].filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    const key=entries.join('|');
    if(key!==lineOptionsKey){
      lineOptionsKey=key;
      select.innerHTML='<option value="">All lines</option>'+entries.map(line=>`<option value="${esc(line)}">${esc(view==='subway'?subwayStyle(line).name:line)}</option>`).join('');
    }
    select.value=selectedLine;
  }
  function focusStation(station){
    focused=station;
    body.scrollTop=0;
    showExpanded(true);
    if(view==='bike')renderDocks();
    else{data=null;renderBoard();queueBoard();}
    if(view==='subway'){moveStationToTarget(station.coordinate);return;}
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
    const boardStations=new Set((data?.stations||[]).map(station=>station.id));
    const stationList=network?.stations||(data?.stations??[...new Map((data?.departures||[]).filter(d=>!selectedLine||d.line===selectedLine).map(d=>[stationID(d),{...d.stop,id:stationID(d)}])).values()]);
    for(const station of stationList){
      const pos=point(station.coordinate);
      if(!map.getBounds().contains(pos))continue;
      const id=station.complexId||station.id,active=focused?.id===id,near=boardStations.has(id);
      L.circleMarker(pos,{radius:active||near?6:4,color:view==='bus'?'#2262aa':active||near?'#243dcd':'#233142',
        weight:active||near?2.5:1.7,fillColor:active?'#dbe2ff':'#fff',fillOpacity:1})
        .bindTooltip(esc(station.name)).on('click',()=>focusStation({...station,id})).addTo(stops);
    }
  }
  function renderSubwayBoard(rows,stale){
    const fallback=[...new Map(rows.map(row=>[stationID(row),{...row.stop,id:stationID(row),metersAway:row.metersAway}])).values()];
    const stations=data?.stations??fallback.sort((a,b)=>a.metersAway-b.metersAway).slice(0,4);
    if(focused)count.textContent=focused.name;
    else if(stations.length)count.textContent=`${stations.length} closest ${stations.length===1?'station':'stations'}`;
    else count.textContent=data?'Near the map marker':'Drag the map to find stations';
    const empty=data?(selectedLine?'No stations for this line near the marker. Drag the map or choose All lines.':'No stations within ¾ mile. Drag the map to explore.'):'Checking nearby stations…';
    const message=failure||(stale?'Current MTA predictions are unavailable.':empty);
    const scroll=body.scrollTop;
    body.innerHTML=(focused?'<button class="live-back" data-live-back>‹ Nearby stations</button>':'')+
      (stations.length?stations.map(station=>{
        const routes=new Map(),directions=new Map();
        for(const departure of rows){
          if(stationID(departure)!==station.id)continue;
          routes.set(departure.line,departure.routeColor);
          const direction=departure.direction||'Upcoming trains';
          if(!directions.has(direction))directions.set(direction,[]);
          directions.get(direction).push(departure);
        }
        const name=`<span><strong>${esc(station.name)}</strong>${focused?'':`<small>${feet(station.metersAway)}</small>`}</span>`;
        const badges=`<span class="subway-station-lines">${[...routes].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([line,color])=>subwayBullet(line,color)).join('')}</span>`;
        const header=focused?`<div class="subway-station-head">${name}${badges}</div>`:`<button class="subway-station-head" data-live-station="${esc(station.id)}">${name}${badges}${icon('chevron')}</button>`;
        const arrivals=[...directions].sort(([a],[b])=>directionOrder(a)-directionOrder(b)||a.localeCompare(b)).map(([direction,items])=>{
          const seen=new Set();
          const shown=focused?items.slice(0,12):items.filter(item=>!seen.has(item.line)&&seen.add(item.line)).slice(0,4);
          return `<div class="subway-direction"><strong>${esc(direction)}</strong><span>${shown.map(row=>`<span class="subway-arrival">${subwayBullet(row.line,row.routeColor)}${arrivalTime(row)}</span>`).join('')}</span></div>`;
        }).join('');
        return `<section class="subway-station">${header}${arrivals||`<p class="live-empty">${stale?'MTA predictions unavailable.':'No live departures reported.'}</p>`}</section>`;
      }).join(''):`<p class="live-empty">${esc(message)}</p>`);
    body.scrollTop=scroll;
  }
  function renderBoard(){
    updateLines();
    renderStops();
    const rows=(data?.departures||[]).filter(d=>(!selectedLine||d.line===selectedLine)&&Date.parse(d.departureTime)>Date.now()-30000);
    const blocked=view==='bus'&&data?.feedStatus?.bus?.configured===false;
    const stale=data&&(view==='bus'?data.feedStatus.bus.stale:data.feedStatus.subway.every(feed=>feed.stale));
    if(view==='subway'){renderSubwayBoard(rows,stale);return;}
    count.textContent=focused?.name||(data?`${new Set(rows.map(stationID)).size} stops near map center`:'Pan to a stop or choose a line');
    const groups=new Map();
    for(const departure of rows){
      const id=stationID(departure),key=focused?`${departure.line}|${departure.direction||''}`:`${id}|${departure.line}|${departure.direction||''}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(departure);
    }
    const contents=[...groups.values()].slice(0,18).map(group=>{
      const d=group[0],times=group.slice(0,3).map(arrivalTime).join('');
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
    const center=view==='subway'?map.containerPointToLatLng(targetPoint()):map.getCenter();
    const where=focused?.coordinate||{latitude:center.lat,longitude:center.lng};
    const query=new URLSearchParams({lat:where.latitude.toFixed(4),lon:where.longitude.toFixed(4),mode:view});
    if(focused)query.set('stop',focused.id);
    if(view==='subway'&&selectedLine)query.set('line',selectedLine);
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
    clearTimeout(moveTimer);pending?.abort();pending=null;
    moveTimer=setTimeout(refresh,view==='subway'?260:420);
  }
  function reset(){
    data=null;network=null;focused=null;selectedLine='';failure='';
    pending?.abort();pending=null;clearTimeout(moveTimer);
    lines.clearLayers();stops.clearLayers();dockLayer.clearLayers();
  }
  map.on('dragstart',()=>{
    if(view!=='subway')return;
    focused=null;pending?.abort();pending=null;
    clearTimeout(moveTimer);
    body.scrollTop=0;
    target.classList.add('panning');
  });
  map.on('moveend',()=>{
    target.classList.remove('panning');
    if(view==='bike')renderDocks();
    else if(view!=='directions'&&!focused)queueBoard();
  });
  map.on('resize',()=>{if(view==='subway'&&!focused)queueBoard();});
  panel.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button)return;
    if(button.hasAttribute('data-live-toggle'))showExpanded(detail.hidden);
    if(button.hasAttribute('data-live-refresh')){refresh();vehicles.refresh();}
    if(button.hasAttribute('data-live-center')){
      focused=null;const coordinate=getLocation();
      if(view==='subway')moveStationToTarget(coordinate||{latitude:cityCenter[0],longitude:cityCenter[1]},15);
      else map.setView(coordinate?point(coordinate):cityCenter,15);
      if(view==='bike')renderDocks();else queueBoard();
    }
    if(button.hasAttribute('data-live-back')){
      focused=null;
      if(view==='bike')renderDocks();else{data=null;renderBoard();queueBoard();}
    }
    const id=button.dataset.liveStation;
    if(!id)return;
    const station=data?.stations?.find(item=>item.id===id)||data?.departures?.find(item=>stationID(item)===id)?.stop;
    if(station)focusStation({...station,id});
  });
  select.addEventListener('change',()=>{
    selectedLine=select.value;network=null;lines.clearLayers();
    if(view==='subway')body.scrollTop=0;
    vehicles.setLine(selectedLine);renderBoard();
    if(view==='subway')queueBoard();
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
      target.hidden=view!=='subway';
      panel.hidden=view==='directions';panel.dataset.mode=view;
      vehicles.setView(view);
      if(panel.hidden)return;
      heading.textContent=titles[view];
      count.textContent=view==='bike'?'Checking dock availability…':view==='subway'?'Drag the map to find stations':'Checking nearby stops…';
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
      const corridors=new Map();
      for(const segment of network?.segments||[]){
        const color=subwayStyle(segment.line,segment.color).color;
        const key=segment.points.map(p=>p.join(',')).sort().join('|')+'|'+color;
        if(!corridors.has(key))corridors.set(key,{points:segment.points,color});
      }
      const weight=selectedLine?5.5:4;
      for(const {points} of corridors.values())L.polyline(points,{renderer:railRenderer,color:'#fff',weight:weight+2.5,interactive:false}).addTo(lines);
      for(const {points,color} of corridors.values())L.polyline(points,{renderer:railRenderer,color,weight,opacity:.92,interactive:false}).addTo(lines);
      const qty=result?.vehicles?.length??0,bus=view==='bus';
      status.textContent=result?(bus&&result.feedStatus.busVehicles?.stale?'Bus GPS unavailable':`${qty} ${bus?'bus GPS positions':'train station estimates'}${result.truncated?' · zoom in':''}`):'Vehicle reports unavailable';
      renderStops();updateLines();
    }
  };
}
