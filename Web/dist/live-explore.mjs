import {icon} from './icons.mjs';
import {subwayBullet,subwayStyle} from './subway-ui.mjs';
import {liveTimeMarkup,subwayArrivalLabel,updateLiveTimes} from './transit-arrivals.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const point=coordinate=>[coordinate.latitude,coordinate.longitude];
const cityCenter=[40.757,-73.977];
const titles={subway:'Subway arrivals',bus:'Bus arrivals',bike:'Citi Bike docks'};
const clock=value=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}):'';
const stationID=departure=>departure.stationId||(departure.mode==='subway'?departure.stop.id.replace(/[NS]$/,''):departure.stop.id);
const usable=station=>Date.now()-station.reportedAt<=300000&&station.reportedAt<=Date.now()+120000;
const dockColor=(station,stale)=>stale||!usable(station)||!station.isRenting?'#667683':station.classicBikes===0&&station.ebikes>0?'#6749c7':station.bikes>0?'#117959':'#bd4425';
const dockCounts=station=>`${station.isRenting?`${station.classicBikes??'?'} classic · ${station.ebikes??'?'} e-bikes`:'Pickup paused'} · ${station.isReturning?station.docks+' open docks':'Returns paused'}`;
const badge=departure=>`<span class="live-line" style="--line-color:#2262aa">${esc(departure.line)}</span>`;
const feet=meters=>meters<30?'At map center':meters<805?`${Math.round(meters*3.28084/25)*25} ft away`:`${(meters/1609.344).toFixed(1)} mi away`;
const directionOrder=direction=>direction==='Uptown'?0:direction==='Downtown'?1:2;

export function attachLiveExplore({map,L,api,vehicles,getLocation,onSelect,openLineSheet}){
  const panel=document.querySelector('#live-explore'),body=panel.querySelector('.live-board'),count=panel.querySelector('.live-count'),target=document.querySelector('#transit-target');
  const nearby=panel.querySelector('.transit-nearby');
  const heading=panel.querySelector('.live-title'),status=panel.querySelector('.live-map-report'),select=document.querySelector('#live-line-filter');
  const scan=document.querySelector('#live-bike-scan');
  const detail=panel.querySelector('.live-detail'),toggle=panel.querySelector('[data-live-toggle]');
  const lines=L.layerGroup().addTo(map),stops=L.layerGroup().addTo(map),dockLayer=L.layerGroup().addTo(map);
  const railPane=map.createPane('subway-rails');
  railPane.style.zIndex='390';
  railPane.style.pointerEvents='none';
  const railRenderer=L.canvas({pane:'subway-rails',padding:.2});
  const dockRenderer=L.canvas({padding:.2});
  const linesSeen={subway:new Set(),bus:new Set()};
  let view='directions',data,network,focused,selectedStop,selectedLine='',pending,moveTimer,failure='',fitLine=false,tracking=false,dragging=false,settleTimer,refreshLineChoices;
  const showingTransit=()=>view==='subway'||view==='bus';

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
  const allLines=()=>view==='subway'?'All subway lines':'All bus routes';
  const lineName=line=>view==='subway'?subwayStyle(line).name:line;
  function changeLine(line){
    if(line===selectedLine)return;
    selectedLine=line;fitLine=Boolean(line);network=null;data=null;focused=null;selectedStop=null;failure='';
    lines.clearLayers();body.scrollTop=0;nearby.scrollLeft=0;
    select.querySelector('.live-line-current').textContent=line?lineName(line):allLines();
    status.textContent=line&&view==='bus'?'Loading route path…':'';
    vehicles.setStationPredictions([]);vehicles.setLine(line);
    renderBoard();queueBoard();
  }
  function showLinePicker(){
    const bus=view==='bus',title=bus?'Choose a bus route':'Choose a subway line';
    const dialog=openLineSheet(title,`<input id="line-query" class="search-input" type="search" aria-label="${bus?'Find a bus route':'Find a subway line'}" placeholder="${bus?'Search routes, e.g. M15':'Search lines, e.g. 6'}" autocomplete="off"><div class="line-options"></div>`);
    const input=dialog.querySelector('#line-query'),list=dialog.querySelector('.line-options');
    refreshLineChoices=()=>{
      if(!dialog.open||!input.isConnected)return;
      const shortlist=new Set((data?.departures||[]).map(row=>row.line));
      const catalog=[...new Set([...shortlist,...linesSeen[view],selectedLine].filter(Boolean))].sort((a,b)=>Number(shortlist.has(b))-Number(shortlist.has(a))||a.localeCompare(b,undefined,{numeric:true}));
      const key=normalizeLine(input.value),shown=catalog.filter(line=>!key||normalizeLine(line).includes(key)||normalizeLine(lineName(line)).includes(key));
      list.innerHTML=`<button data-map-line="" aria-pressed="${!selectedLine}">${allLines()}</button>`+shown.map(line=>{
        const name=lineName(line),bullet=bus?badge({line}):subwayBullet(line);
        return `<button data-map-line="${esc(line)}" aria-label="${esc(name)}" aria-pressed="${selectedLine===line}">${bullet}${!bus&&name!==line?`<span>${esc(name)}</span>`:''}</button>`;
      }).join('')+(key&&!shown.length?'<p class="hint">No matching lines in current service.</p>':'');
    };
    input.addEventListener('input',refreshLineChoices);
    list.addEventListener('click',event=>{
      const button=event.target.closest('[data-map-line]');
      if(button){changeLine(button.dataset.mapLine);dialog.querySelector('[data-action="close"]').click();}
    });
    refreshLineChoices();
  }
  const normalizeLine=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
  select.addEventListener('click',showLinePicker);
  function focusStation(station){
    focused=station;selectedStop=station.id;
    body.scrollTop=0;
    showExpanded(true);
    if(view==='bike')renderDocks();
    else{data=null;renderBoard();queueBoard();}
    if(showingTransit()){moveStationToTarget(station.coordinate);return;}
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
    if(map.getZoom()<(view==='bus'&&!selectedLine?14:12))return;
    const boardStations=new Set((data?.stations||[]).map(station=>station.id));
    const stationList=network?.stations?.length?network.stations:(data?.stations??[...new Map((data?.departures||[]).filter(d=>!selectedLine||d.line===selectedLine).map(d=>[stationID(d),{...d.stop,id:stationID(d)}])).values()]);
    for(const station of stationList){
      const pos=point(station.coordinate);
      if(!map.getBounds().contains(pos))continue;
      const id=station.complexId||station.id,active=(focused?.id||selectedStop)===id,near=boardStations.has(id);
      L.circleMarker(pos,{radius:active||near?6:4,color:view==='bus'?'#2262aa':active||near?'#243dcd':'#233142',
        weight:active||near?2.5:1.7,fillColor:active?(view==='bus'?'#d3e7fb':'#dbe2ff'):'#fff',fillOpacity:1})
        .bindTooltip(esc(station.name)).on('click',()=>focusStation({...station,id})).addTo(stops);
    }
  }
  function renderStopPicker(stations,active){
    nearby.hidden=Boolean(focused)||stations.length===0;
    if(nearby.hidden){nearby.innerHTML='';return;}
    const scroll=nearby.scrollLeft;
    const markup=stations.map(station=>`<button class="transit-stop-choice" data-board-stop="${esc(station.id)}" aria-pressed="${station.id===active.id}"><strong>${esc(station.name)}</strong><small>${feet(station.metersAway)}</small></button>`).join('');
    if(nearby.innerHTML!==markup){nearby.innerHTML=markup;nearby.scrollLeft=scroll;}
  }
  function subwayTimes(rows){
    const groups=new Map();
    for(const item of rows){
      const direction=item.direction||'Upcoming trains';
      if(!groups.has(direction))groups.set(direction,[]);
      groups.get(direction).push(item);
    }
    return [...groups].sort(([a],[b])=>directionOrder(a)-directionOrder(b)||a.localeCompare(b)).map(([direction,items])=>{
      const seen=new Set();
      const shown=focused?items.slice(0,12):items.filter(item=>!seen.has(item.line)&&seen.add(item.line)).slice(0,4);
      return `<div class="arrival-direction"><strong>${esc(direction)}</strong><span>${shown.map(row=>departureButton(row,subwayBullet(row.line,row.routeColor),'subway-arrival')).join('')}</span></div>`;
    }).join('');
  }
  function busTimes(rows){
    const groups=new Map();
    for(const item of rows){
      const key=[item.line,item.direction||''].join('|');
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(item);
    }
    return [...groups.values()].map(items=>{
      const first=items[0];
      return `<div class="bus-arrival">${selectedLine?badge(first):`<button class="bus-route-link" data-select-line="${esc(first.line)}" aria-label="Show route ${esc(first.line)}">${badge(first)}</button>`}<small>${esc(first.direction||'Live arrival')}</small><span>${items.slice(0,3).map(row=>departureButton(row,'','bus-departure')).join('')}</span></div>`;
    }).join('');
  }
  function departureButton(row,bullet,className){
    const time=liveTimeMarkup(row,vehicles.findTrip(row.trackingId));
    if(!row.trackingId)return `<span class="${className}">${bullet}${time}</span>`;
    return `<button class="${className}" data-track-trip="${esc(row.trackingId)}" title="Follow ${esc(row.line)}">${bullet}${time}</button>`;
  }
  function renderBoard(){
    const rows=(data?.departures||[]).filter(d=>(!selectedLine||(view==='bus'?normalizeLine(d.line)===normalizeLine(selectedLine):d.line===selectedLine))&&
      (view==='subway'||Date.parse(d.departureTime)>=Date.now()));
    for(const row of rows)linesSeen[view].add(row.line);
    const fallback=[...new Map(rows.map(row=>[stationID(row),{...row.stop,id:stationID(row),metersAway:row.metersAway}])).values()];
    const stations=data?.stations??fallback.sort((a,b)=>a.metersAway-b.metersAway).slice(0,4);
    const active=stations.find(station=>station.id===selectedStop)||stations[0];
    selectedStop=active?.id;
    const label=view==='bus'?'stop':'station';
    if(focused)count.textContent=focused.name;
    else if(stations.length)count.textContent=`${stations.length} nearby ${label}${stations.length===1?'':'s'}`;
    else count.textContent=data?'Near the map marker':`Drag the map to find ${label}s`;
    renderStopPicker(stations,active);
    renderStops();
    const blocked=view==='bus'&&data?.feedStatus?.bus?.configured===false;
    const stale=data&&(view==='bus'?data.feedStatus.bus.stale:data.feedStatus.subway.every(feed=>feed.stale));
    const timing=active?rows.filter(item=>stationID(item)===active.id&&
      (view!=='subway'||subwayArrivalLabel(item,vehicles.findTrip(item.trackingId))!=null)):[];
    vehicles.setStationPredictions(view==='subway'&&!stale?timing:[]);
    const arrivals=view==='subway'?subwayTimes(timing):busTimes(timing);
    const empty=active?'No live arrivals reported at this stop.':data?
      (selectedLine?`Tap a ${label} along ${lineName(selectedLine)} to check arrivals.`:`No ${label}s within ¾ mile. Drag the map to explore.`):`Checking nearby ${label}s…`;
    const message=failure||(stale?'Current MTA reports are unavailable.':empty);
    const scroll=body.scrollTop;
    const more=view==='subway'&&active&&!focused&&arrivals?`<button class="live-back" data-live-station="${esc(active.id)}">All departures ${icon('chevron')}</button>`:'';
    body.innerHTML=(focused?`<button class="live-back" data-live-back>‹ Nearby ${label}s</button>`:'')+
      (blocked?'<p class="live-empty">Bus Time needs a connection.</p><button class="text-button" data-action="sources">Open Sources</button>':
      arrivals?arrivals+more:`<p class="live-empty">${esc(message)}</p>`);
    body.scrollTop=scroll;
  }
  async function refresh(){
    if(view==='directions'||tracking||document.hidden)return;
    if(view==='subway'){vehicles.refresh();return;}
    pending?.abort();
    const controller=new AbortController();pending=controller;
    const center=showingTransit()?map.containerPointToLatLng(targetPoint()):map.getCenter();
    const where=focused?.coordinate||{latitude:center.lat,longitude:center.lng};
    const query=new URLSearchParams({lat:where.latitude.toFixed(4),lon:where.longitude.toFixed(4),mode:view});
    if(focused)query.set('stop',focused.id);
    if(showingTransit()&&selectedLine)query.set('line',selectedLine);
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
    moveTimer=setTimeout(refresh,showingTransit()?120:260);
  }
  function reset(){
    data=null;network=null;focused=null;selectedStop=null;selectedLine='';failure='';fitLine=false;
    dragging=false;target.classList.remove('panning','settled');
    nearby.hidden=true;nearby.innerHTML='';
    pending?.abort();pending=null;clearTimeout(moveTimer);
    lines.clearLayers();stops.clearLayers();dockLayer.clearLayers();
  }
  map.on('dragstart',()=>{
    if(!showingTransit()||tracking)return;
    vehicles.setStationPredictions([]);
    dragging=true;
    target.classList.remove('settled');
    focused=null;selectedStop=null;pending?.abort();pending=null;
    nearby.scrollLeft=0;
    clearTimeout(moveTimer);
    body.scrollTop=0;
    target.classList.add('panning');
  });
  map.on('moveend',()=>{
    target.classList.remove('panning');
    if(dragging&&showingTransit()){
      dragging=false;
      target.classList.add('settled');
      clearTimeout(settleTimer);
      settleTimer=setTimeout(()=>target.classList.remove('settled'),300);
      if(navigator.maxTouchPoints>0)navigator.vibrate?.(10);
    }
    if(view==='bike')renderDocks();
    else if(view!=='directions'&&!focused)queueBoard();
  });
  map.on('resize',()=>{if(showingTransit()&&!focused)queueBoard();});
  panel.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button)return;
    if(button.dataset.selectLine){changeLine(button.dataset.selectLine);return;}
    if(button.dataset.trackTrip){
      const row=data?.departures?.find(item=>item.trackingId===button.dataset.trackTrip&&stationID(item)===selectedStop);
      if(row)onSelect(vehicles.findTrip(row.trackingId)||{...row,accuracy:'arrival-only',
        status:`Estimated arrival at ${row.stop.name}`,directionLabel:row.direction,reportedAt:row.predictionReportedAt});
      return;
    }
    if(button.hasAttribute('data-live-toggle'))showExpanded(detail.hidden);
    if(button.hasAttribute('data-live-refresh')){refresh();vehicles.refresh();}
    if(button.hasAttribute('data-live-center')){
      focused=null;selectedStop=null;const coordinate=getLocation();
      if(showingTransit())moveStationToTarget(coordinate||{latitude:cityCenter[0],longitude:cityCenter[1]},15);
      else map.setView(coordinate?point(coordinate):cityCenter,15);
      if(view==='bike')renderDocks();else queueBoard();
    }
    if(button.hasAttribute('data-live-back')){
      focused=null;selectedStop=null;
      if(view==='bike')renderDocks();else{data=null;renderBoard();queueBoard();}
    }
    if(button.dataset.boardStop){
      selectedStop=button.dataset.boardStop;body.scrollTop=0;renderBoard();return;
    }
    const id=button.dataset.liveStation;
    if(!id)return;
    const station=data?.stations?.find(item=>item.id===id)||data?.departures?.find(item=>stationID(item)===id)?.stop;
    if(station)focusStation({...station,id});
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(refresh,30000);
  setInterval(()=>{
    if(view==='bike'||view==='directions'||document.hidden||detail.hidden)return;
    if(updateLiveTimes(body,vehicles.findTrip)&&view==='subway')renderBoard();
  },1000);

  return {
    subwayBoardQuery(){
      if(view!=='subway'||tracking||dragging)return null;
      const center=map.containerPointToLatLng(targetPoint());
      const {latitude,longitude}=focused?.coordinate??{latitude:center.lat,longitude:center.lng};
      return {lat:latitude.toFixed(4),lon:longitude.toFixed(4),...(focused?{stop:focused.id}:{})};
    },
    setTracking(value){
      tracking=value;
      if(tracking){pending?.abort();pending=null;clearTimeout(moveTimer);vehicles.setStationPredictions([]);}
      else if(showingTransit())queueBoard();
    },
    setView(next){
      if(next===view)return;
      view=next;reset();
      target.hidden=!showingTransit();target.dataset.mode=view;
      panel.hidden=view==='directions';panel.dataset.mode=view;
      select.hidden=!showingTransit();scan.hidden=view!=='bike';
      if(showingTransit())select.querySelector('.live-line-current').textContent=allLines();
      vehicles.setView(view);
      if(panel.hidden)return;
      heading.textContent=titles[view];
      count.textContent=view==='bike'?'Checking dock availability…':view==='subway'?'Drag the map to find stations':'Drag the map to find stops';
      status.textContent=view==='bike'?'Citi Bike GBFS':view==='bus'?'MTA Bus Time GPS':'Estimated from live train reports';
      body.innerHTML='<p class="live-empty">Loading live reports…</p>';
      panel.querySelector('.live-legend').hidden=view!=='bike';
      showExpanded(true);
      refresh();
    },
    vehicleReport(mode,result){
      if(mode!==view||view==='directions'||view==='bike')return;
      network=result?.network;
      const known=linesSeen[view].size;
      for(const line of result?.availableLines||[])linesSeen[view].add(line);
      if(linesSeen[view].size!==known)refreshLineChoices?.();
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
      if(fitLine&&corridors.size){
        fitLine=false;
        const narrow=matchMedia('(max-width:700px)').matches,bottom=map.getSize().y*.34;
        const bounds=L.latLngBounds([...corridors.values()].flatMap(segment=>segment.points));
        map.fitBounds(bounds,{maxZoom:15,animate:false,
          paddingTopLeft:narrow?[18,114]:[400,84],paddingBottomRight:narrow?[18,bottom+98]:[28,48]});
      }
      const qty=result?.vehicles?.length??0,bus=view==='bus';
      status.textContent=result?(bus&&result.feedStatus.busVehicles?.stale?'Bus GPS unavailable':bus?
        `${qty} GPS positions${result.truncated?' · zoom in':''}${selectedLine&&!corridors.size?' · Route path unavailable':''}`:'Estimated from live train reports'):'Vehicle reports unavailable';
      if(view==='subway'&&!tracking&&!dragging){
        data=result?.board??null;
        failure=result?'':'Subway reports unavailable here.';
        renderBoard();
      }else renderStops();
    }
  };
}
