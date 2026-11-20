import * as L from 'leaflet';
import {icon} from './icons.mjs';
import {defaults,labels,routeTitle,bikePaceKeys,bikePaces,linkedBikePaces} from './preferences.mjs';
import {nyLocalInput,nyTimeToISO,timingPayload,timingLabel} from './timing.mjs';
import {attachVehicleMap} from './vehicles.mjs';
import {attachVehicleTracking} from './vehicle-tracks.mjs';
import {attachLiveExplore} from './live-explore.mjs';
import {attachMobileLayout} from './mobile-layout.mjs';
import {CURRENT_LOCATION_ID,createCurrentLocationLookup} from './current-location.mjs';
import {deviceLocation} from './location-startup.mjs';
import {departureOptions,resolveDeparture,canChooseDeparture} from './transit-choices.mjs';
import {createLiveNavigation} from './live-navigation.mjs';
import {searchRoutes} from './route-search.mjs';
const $=(s,root=document)=>root.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mins=n=>Math.ceil(n),money=c=>c===0?'Included':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100),clock=s=>s?new Date(s).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}):'—';
const state={origin:null,destination:null,location:{status:'idle'},preferences:defaults(),response:null,earlyRoute:null,selected:0,loading:false,error:null,health:null,places:[],landmarks:[],saved:[],favoritePlaces:[],modal:null,journey:null,timing:{mode:'now',time:null},travelMode:'all',mainView:'directions'};
const sheet=$('#sheet'),app=$('#app'),preview=$('#journey-preview'),navigationPanel=$('#navigation-controls');
let searchId=0,searchTimer,placeAbort,toastTimer,map,layers,abort,vehicleMap,vehicleTracking,liveExplore,mobileLayout,navigationMarkers;
const departureSelections={};let departureRequestKey="";
const bikePaceStorage='crosstown.bikePaces.v1';
try{Object.assign(state.preferences,bikePaces(JSON.parse(localStorage.getItem(bikePaceStorage))));}catch{}
function lineBadges(leg){
 const choices=leg.mode==='subway'&&leg.lineOptions?.length?leg.lineOptions:[{line:leg.line,routeColor:leg.routeColor}];
 return choices.filter(option=>option.line).map(option=>`<span class="line-badge ${leg.mode==='bus'?'bus':''}" style="background:#${/^[0-9a-f]{6}$/i.test(option.routeColor)?option.routeColor:leg.mode==='bus'?'3678c7':'239a68'};${['FCCC0A','F9B514'].includes(option.routeColor?.toUpperCase())?'color:#171c25':''}">${esc(option.line)}</span>`).join('');
}
function trainChoices(route,index){
 const options=departureOptions(route,index,state.response);
 return `<details class="train-choices"><summary>Choose a train</summary>${options.length?options.map(option=>`<button class="departure-choice" data-departure-choice="${esc(option.choiceId)}" aria-pressed="${option.choiceId===route.choiceId}"><span><strong>${esc(option.legs[index].line)} · ${clock(option.legs[index].departureTime)}</strong><small>Arrive ${clock(option.arrivalTime)} · ${mins(option.minutes)} min total</small></span><span>${option.choiceId===route.choiceId?'✓':'Choose'}</span></button>`).join(''):'<p class="hint">Refresh this trip for current departures.</p>'}</details>`;
}
try{const s=JSON.parse(localStorage.getItem('crosstown.saved.v2')||'[]');state.saved=Array.isArray(s)?s.filter(x=>x.origin?.coordinate&&x.destination?.coordinate&&x.preferences).slice(0,30):[];}catch{}
const favoritePlaceStorage='crosstown.favoritePlaces.v1';
try{
 const saved=JSON.parse(localStorage.getItem(favoritePlaceStorage)||'[]');
 if(Array.isArray(saved))state.favoritePlaces=saved.filter(item=>typeof item?.label==='string'&&item.place?.id&&item.place.name&&Number.isFinite(item.place.coordinate?.latitude)&&Number.isFinite(item.place.coordinate?.longitude)).slice(0,30);
}catch{}
async function api(url,options={}){const r=await fetch('/api'+url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const d=await r.json();if(!r.ok)throw Error(d.error||'The request could not be completed.');return d;}
function toast(s){clearTimeout(toastTimer);$('#toast').textContent=s;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3000);}
function hydrate(root=document){for(const n of root.querySelectorAll('[data-icon]'))n.innerHTML=icon(n.dataset.icon);}
function updateFields(){$('#origin-label').textContent=state.location.status==='loading'&&!state.origin?'Finding your location…':state.origin?.name||'Current location';$('#destination-label').textContent=state.destination?.name||'Choose a destination';$('#departure-label').textContent=timingLabel(state.timing);$('[data-action="swap"]').disabled=!state.origin||!state.destination;for(const b of document.querySelectorAll('[data-priority]')){const active=b.dataset.priority===state.preferences.priority;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);}$('#custom-note').hidden=state.preferences.priority!=='custom';}
function clearTrip(){searchId++;abort?.abort();state.loading=false;state.response=null;state.earlyRoute=null;state.error=null;$('[data-action="refresh"]').disabled=false;}
const currentLocation=createCurrentLocationLookup({source:deviceLocation,onUpdate:(update,options)=>{
 state.location=update;
 if(update.place){const first=!state.origin;state.origin=update.place;renderRoutes();drawRoute(first);planTrip(options);}
 else {if(update.status==='error'){state.origin=null;clearTrip();drawRoute(false);}renderRoutes();}
}});
function useCurrentLocation(){closeJourney({focus:false});currentLocation.cancel();state.origin=null;state.travelMode='all';clearTrip();if(state.modal?.type==='place'){cancelPlaceSearch();sheet.close();state.modal=null;}currentLocation.request();}
function refreshTrip(options={}){if(state.origin?.id===CURRENT_LOCATION_ID||!state.origin)return currentLocation.request(options);return planTrip(options);}
function matchesTravelMode(route,mode){
 if(mode==='all')return true;
 if(mode==='walk')return route.legs.every(leg=>leg.mode==='walk');
 return route.legs.some(leg=>leg.mode===mode)&&(mode==='bike'||route.legs.every(leg=>leg.mode===mode||leg.mode==='walk'));
}
function currentRoutes(){
 const mode=state.travelMode,all=state.response?.routes||[];
 let routes=all;
 if(mode==='all'){
  if(state.preferences.priority==='sheltered')routes=all.filter(route=>route.legs.some(leg=>leg.mode==='subway'||leg.mode==='bus')&&route.legs.every(leg=>leg.mode!=='bike'));
 }else{
  routes=state.response?.routeGroups?.[mode]??all.filter(route=>matchesTravelMode(route,mode));
 }
 return routes.map(route=>resolveDeparture(route,state.response,departureSelections));
}
async function planTrip({quiet=false}={}){
 if(!quiet&&state.journey)closeJourney({focus:false});
 if(!state.origin||!state.destination)return;const key=JSON.stringify([state.origin.id,state.destination.id,state.preferences,state.timing]);if(key!==departureRequestKey){for(const id of Object.keys(departureSelections))delete departureSelections[id];departureRequestKey=key;}const id=++searchId;abort?.abort();abort=new AbortController();state.loading=true;state.error=null;state.earlyRoute=null;
 if(!quiet){state.response=null;state.selected=0;renderRoutes();drawRoute();}$('[data-action="refresh"]').disabled=true;
 try{
  const request={origin:state.origin,destination:state.destination,preferences:state.preferences,...timingPayload(state.timing)};
  const r=await searchRoutes(request,{signal:abort.signal,onPreview:quiet?undefined:route=>{
   if(id!==searchId)return;
   state.earlyRoute=route;
   renderRoutes();
  }});
  if(id!==searchId)return;
  const previous=currentRoutes()[state.selected]?.id;
  state.response=r;
  for(const key of Object.keys(departureSelections))if(!r.alternativeRoutes?.[departureSelections[key]])delete departureSelections[key];
  state.health={...state.health,router:r.router??state.health?.router,feeds:r.feedStatus};
  state.selected=Math.max(0,currentRoutes().findIndex(x=>x.id===previous));
 }
 catch(e){if(id!==searchId||e.name==='AbortError')return;state.error=e.message;state.response=null;}
 if(id!==searchId)return;state.loading=false;state.earlyRoute=null;$('[data-action="refresh"]').disabled=false;renderRoutes();drawRoute(!quiet&&!state.journey);updateFreshness();
}
function renderRoutes(){
 updateFields();const list=$('#route-list');for(const b of document.querySelectorAll('[data-travel-mode]')){const active=b.dataset.travelMode===state.travelMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
 const mode=state.travelMode,sheltered=mode==='all'&&state.preferences.priority==='sheltered';
 const first=state.loading&&!state.response&&state.earlyRoute&&matchesTravelMode(state.earlyRoute,mode)?state.earlyRoute:null;
 const shortcut=$('.early-route-shortcut');
 shortcut.hidden=!first;
 if(first){
  shortcut.textContent=`View · ${mins(first.minutes)} min`;
  shortcut.setAttribute('aria-label',`Open first route, ${routeTitle(first)}, ${mins(first.minutes)} minutes`);
 }
 const description={subway:'Trips where the subway accounts for most of the ride time.',bus:'Trips where buses account for most of the ride time.',walk:'Walking routes within your walking limit.',bike:'Routes that include a bike ride.'};
 const context=$('#mode-context');
 const fastest=group=>Math.min(...(state.response?.routeGroups?.[group]||[]).map(route=>route.minutes));
 const walk=fastest('walk'),bike=fastest('bike');
 const comparison=mode==='all'&&!sheltered&&Number.isFinite(walk)&&Number.isFinite(bike)?`Walk ${mins(walk)} min · With bike ${mins(bike)} min` : '';
 context.textContent=state.response?.partialSearch?'Some route searches could not finish. Refresh to compare all options.':sheltered?'Subway and bus trips ranked by estimated time outside.':description[mode]||comparison;
 context.hidden=!context.textContent;
 if(!state.origin||!state.destination){const locating=state.location.status==='loading';$('#results-subtitle').textContent=locating?'Finding your current location':!state.origin?'Choose a start to find routes':'Choose a destination';list.innerHTML=`<div class="empty">${icon('locate')}<h3>${locating?'Finding your location…':!state.origin?'Start where you are.':'Where to?'}</h3><p>${esc(state.location.message||(locating?'Allow location access to find routes from where you are.':'Use your current location or choose a starting address.'))}</p>${!locating?'<button class="primary" data-action="current-location">Use current location</button>':''}<button class="text-button" data-place="${state.origin?'destination':'origin'}">Choose ${state.origin?'a destination':'a start'}</button></div>`;return;}
 if(state.loading&&!state.response){
  if(first){
   $('#results-subtitle').textContent='Comparing more routes…';
   list.innerHTML=`<button class="route" data-action="early-route" aria-label="Open first route, ${esc(routeTitle(first))}, ${mins(first.minutes)} minutes"><div class="route-label"><span>FIRST OPTION</span></div><div class="route-main"><div><div class="route-title">${esc(routeTitle(first))}</div><p class="route-subtitle">Arrive ${clock(first.arrivalTime)}</p></div><div class="duration"><b>${mins(first.minutes)}</b><small>min</small></div></div></button>`;
  }else{
   $('#results-subtitle').textContent='Checking connections…';
   list.innerHTML='<div class="loading"><i></i><strong>Checking service times and streets</strong></div>';
  }
  return;
 }
 if(state.error){$('#results-subtitle').textContent='Connection needed';list.innerHTML=`<div class="empty">${icon('activity')}<h3>We couldn’t check this trip.</h3><p>${esc(state.error)}</p><button class="primary" data-action="refresh">Try again ${icon('refresh')}</button><p class="hint">Run the included Crosstown launcher if you’re using the app locally.</p></div>`;return;}
 const routes=currentRoutes();$('#results-subtitle').textContent=routes.length?`${routes.length} routes · best match ${mins(routes[0].minutes)} min · ${labels[state.preferences.priority].toLowerCase()}`:'No connections within your limits';
 if(!routes.length){context.hidden=false;context.textContent=mode!=='all'&&!state.preferences.modes.includes(mode)?`${mode==='bike'?'Biking':mode==='subway'?'Subway':mode==='bus'?'Buses':'Walking'} is turned off. Enable it in Make it mine.`:mode==='bus'&&state.preferences.bikeSource==='ownBike'?'Your own bike cannot board a bus. Choose Citi Bike to compare bus connections.':mode==='bus'&&state.preferences.requireLiveTransit&&!state.health?.feeds?.bus?.configured?'Live buses need a Bus Time connection. Connect it in Sources, or explicitly allow schedules.':sheltered?'No subway or bus trip fits these limits.':`No eligible ${mode==='all'?'':mode+' '}route was found within your limits${state.preferences.requireLiveTransit?' and current live reports':''}. Walking limit: ${state.preferences.maxWalkingMinutes} min. Biking limit: ${state.preferences.maxBikingMinutes} min.`;list.innerHTML=`<div class="empty">${icon('sliders')}<h3>A little more room?</h3><p>${sheltered?'Allow a longer walk or check which transit modes and schedules you use.':'No reachable route fits these limits. Try more walking or biking time, another mode, or allow scheduled transit when live predictions are missing.'}</p><button class="primary" data-action="preferences">Adjust my limits</button></div>`;return;}
 list.innerHTML=routes.map((r,i)=>{const ride=r.legs.find(l=>l.mode!=='walk'),subtitle=ride?.mode==='bike'?`Bike to ${ride.to.name}`:ride?.line?`${ride.from.name} → ${ride.to.name}`:'Walk to your destination';return `<button class="route ${i===state.selected?'selected':''}" data-route="${i}" aria-label="${esc(routeTitle(r))}, ${mins(r.minutes)} minutes, ${money(r.fareCents)} estimated, ${mins(r.outdoorMinutes)} minutes outside. Open route."><div class="route-label"><span>${i===0?'BEST MATCH':'ANOTHER WAY'}</span><span class="quality ${r.dataQuality==='scheduled'?'scheduled':''}"><i></i>${r.dataQuality==='scheduled'?'Includes schedules':r.legs.some(l=>l.realtime)?'Live predictions':r.legs.some(l=>l.bikePickup)?'Live dock data':'Time estimate'}</span></div><div class="route-main"><div><div class="route-title">${esc(routeTitle(r))}</div><p class="route-subtitle">${esc(subtitle)}</p></div><div class="duration"><b>${mins(r.minutes)}</b><small>min</small></div></div><div class="mode-strip" aria-hidden="true">${r.legs.map((l,j)=>`${j?'<span class="mode-arrow">›</span>':''}<span class="mode-part">${l.line?lineBadges(l):icon(l.mode)}${mins(l.duration)}</span>`).join('')}</div><div class="route-bottom"><span><strong>${money(r.fareCents)}</strong> est. · ${mins(r.outdoorMinutes)} min outside</span><span>Arrive ${clock(r.arrivalTime)} ${icon('chevron')}</span></div>${i===state.selected?`<p class="route-insight">${esc(r.explanation)}</p>`:''}</button>`;}).join('');
}
function initMap(){
 const start=state.origin?.coordinate;
 map=L.map('map',{zoomControl:false,attributionControl:true,minZoom:9,maxZoom:19}).setView(start?[start.latitude,start.longitude]:[40.768,-73.974],start?15:13);
 let fallbackStarted=false;
 const fallback=()=>{if(fallbackStarted)return;fallbackStarted=true;L.tileLayer('/tiles/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).on('load',()=>$('#map').dataset.ready='raster').addTo(map);};
 void import('./vendor/maplibre-leaflet/leaflet-maplibre-gl.mjs').then(({maplibreGL})=>{
   const gl=maplibreGL({style:location.origin+'/basemap/styles/positron',attribution:'<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',interactive:false}).addTo(map);
   gl.getMaplibreMap().on('idle',()=>$('#map').dataset.ready='vector');
   gl.getMaplibreMap().on('error',e=>{console.warn('Vector map:',e.error?.message);if(!$('#map').dataset.ready){map.removeLayer(gl);fallback();}});
 }).catch(e=>{console.warn('Vector map:',e.message);fallback();});
 L.control.zoom({position:'bottomright'}).addTo(map);layers=L.featureGroup().addTo(map);
 navigationMarkers=L.layerGroup().addTo(map);
 const selectVehicle=vehicle=>{
   if(state.journey?.navigator)return;
   if(state.mainView==='directions')setMainView(vehicle.mode);
   vehicleTracking.select(vehicle);
 };
 vehicleMap=attachVehicleMap({map,L,api,getRoute:()=>state.journey?.route||currentRoutes()[state.selected],
   onSelect:selectVehicle,onSnapshot:(view,result)=>liveExplore?.vehicleReport(view,result)});
 liveExplore=attachLiveExplore({map,L,api,vehicles:vehicleMap,getLocation:()=>state.origin?.coordinate,onSelect:selectVehicle,openLineSheet:(title,body)=>{
   state.modal={type:'line'};openSheet(title,body);return sheet;
 }});
 vehicleTracking=attachVehicleTracking({map,L,api,findTrip:vehicleMap.findTrip,onReport:vehicleMap.setTrackingReport,onChange:id=>{
   liveExplore.setTracking(Boolean(id));vehicleMap.setSelectedTrip(id);
 }});
 mobileLayout=attachMobileLayout({map,onFit:()=>drawRoute()});
 map.on('dragstart',()=>{
  if(!state.journey?.navigator)return;
  state.journey.following=false;
  $('[data-action="nav-follow"]').setAttribute('aria-pressed','false');
 });
}
function drawRoute(fit=true){
 if(!map)return;
 layers.clearLayers();
 if(state.mainView!=='directions')return;
 const journey=state.journey,r=journey?.route||currentRoutes()[state.selected],caption=$('#map-caption');
 caption.hidden=!r;
 if(r){
  for(const [index,leg] of r.legs.entries()){
   const walk=leg.mode==='walk',completed=journey?.navigator&&index<(journey.stepIndex??0);
   const color=legColor(leg);
   const points=leg.coordinates.map(point=>[point.latitude,point.longitude]);
   const weight=journey?(walk?4:7):(walk?3:5);
   const className=journey?'selected-journey-line':'trip-line';
   L.polyline(points,{color:'#fff',weight:weight+4,opacity:completed ? .5 : .94,interactive:false}).addTo(layers);
   L.polyline(points,{color,weight,className,opacity:completed ? .4 : .98,interactive:false,...(walk?{dashArray:'2 8'}:{})}).addTo(layers);
   if(leg.line&&!completed){
    const position=[leg.from.coordinate.latitude,leg.from.coordinate.longitude];
    L.marker(position,{icon:L.divIcon({className:'pin-container',html:`<div class="transfer-pin" style="background:${color}">${esc(leg.line)}</div>`,iconSize:[22,22],iconAnchor:[11,11]})}).addTo(layers);
   }
  }
  caption.innerHTML=`${icon('check')}<b>Arrive ${clock(r.arrivalTime)}</b> · ${esc(r.dataSummary)} · street time estimated`;
 }
 for(const [p,dest]of [[state.origin,false],[state.destination,true]])if(p)L.marker([p.coordinate.latitude,p.coordinate.longitude],{icon:L.divIcon({className:'pin-container',html:`<div class="route-pin ${dest?'destination':''}"></div>`,iconSize:[21,21],iconAnchor:[10,10]})}).bindTooltip(esc(p.name),{permanent:true,direction:dest?'right':'left',offset:dest?[12,0]:[-12,0],className:'place-tooltip'}).addTo(layers);
 if(fit&&layers.getLayers().length){map.fitBounds(layers.getBounds(),{...mobileLayout.fitPadding(),maxZoom:16,animate:!matchMedia('(prefers-reduced-motion:reduce)').matches});}
 if(!journey?.navigator)vehicleMap?.refresh();
}
function updateFreshness(){const generated=state.response?.generatedAt,age=generated?Math.max(0,Math.floor((Date.now()-Date.parse(generated))/1000)):null,fresh=age!=null&&age<180&&!state.error;$('#freshness').innerHTML=`<i class="status-dot ${fresh?'live':''}"></i>${age==null?'No trip checked yet':age<60?`Checked ${age}s ago`:`Checked ${Math.floor(age/60)}m ago${fresh?'':' · refresh needed'}`}`;const f=state.health?.feeds;$('#source-light').classList.toggle('live',Boolean(f?.subway?.some(s=>!s.stale)&&!f?.bikes?.stale));}
function openSheet(title,body,footer='',actions=''){if(sheet.open)sheet.close();sheet.innerHTML=`<div class="dialog-header"><h2 id="sheet-title">${esc(title)}</h2><div class="detail-actions">${actions}<button class="close" data-action="close" aria-label="Close">${icon('close')}</button></div></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;sheet.showModal();}
function cancelPlaceSearch(){clearTimeout(searchTimer);placeAbort?.abort();}
function choosePlace(endpoint,query=''){
 cancelPlaceSearch();
 state.modal={type:'place',endpoint};
 const title=endpoint==='favorite'?'Add a saved place':endpoint==='origin'?'Where are you starting?':'Where to?';
 openSheet(title,`<input id="place-query" class="search-input" type="search" placeholder="Search a place, restaurant or address" aria-label="Search NYC places">${endpoint==='origin'?`<button class="place-result" data-action="current-location">${icon('locate')}<span><strong>Use current location</strong><small>Start from your device’s location</small></span></button>`:''}<div id="place-favorites"></div><div id="place-results"></div><p id="place-status" class="hint" role="status"></p>`);
 $('#place-query').value=query;
 $('#place-query').focus();
 findPlaces(query);
}
function favoriteButtons(query='',canRemove=false){
 return state.favoritePlaces.map((item,i)=>{
  if(!`${item.label} ${item.place.name} ${item.place.neighborhood??''}`.toLowerCase().includes(query.toLowerCase()))return '';
  return `<div class="place-result-row"><button class="place-result" data-select-favorite="${i}">${icon('bookmark')}<span><strong>${esc(item.label)}</strong><small>${esc(item.place.name)}</small></span>${icon('arrow')}</button>${canRemove?`<button class="place-bookmark" data-remove-favorite="${i}" aria-label="Remove ${esc(item.label)}">${icon('close')}</button>`:''}</div>`;
 }).join('');
}
function renderPlaceFavorites(query){
 const favorites=state.modal?.endpoint!=='favorite'?favoriteButtons(query):'';
 $('#place-favorites').innerHTML=favorites?`<h3 class="saved-section-title">Saved places</h3>${favorites}`:'';
}
function showPlaceMatches(places,message=''){
 state.places=places;
 $('#place-results').innerHTML=places.map((p,i)=>`<div class="place-result-row"><button class="place-result" data-select-place="${i}">${icon('pin')}<span><strong>${esc(p.name)}</strong><small>${esc(p.neighborhood)}</small></span>${icon('arrow')}</button>${state.modal.endpoint==='favorite'?'':`<button class="place-bookmark" data-favorite-result="${i}" aria-label="Save ${esc(p.name)}">${icon('bookmark')}</button>`}</div>`).join('');
 $('#place-status').textContent=message;
}
async function findPlaces(query){
 cancelPlaceSearch();
 const q=query.trim(),controller=new AbortController();
 placeAbort=controller;
 const options={signal:controller.signal},active=()=>!controller.signal.aborted&&state.modal?.type==='place';
 renderPlaceFavorites(q);
 if(!q&&state.landmarks.length){showPlaceMatches(state.landmarks);return;}
 if(q.length===1){showPlaceMatches([],'Enter at least two characters.');return;}
 const path='/places?q='+encodeURIComponent(q);
 showPlaceMatches([],'Searching NYC…');
 try{
  if(q&&!/^\d/.test(q)){
   const nearby=await api(path+'&directory=1',options);
   if(!active())return;
   if(nearby.complete!==false){showPlaceMatches(nearby.places,nearby.places.length?'':'No matches in NYC. Try a street address or landmark.');return;}
   if(nearby.places.length)showPlaceMatches(nearby.places,'Checking other places…');
  }
  const result=await api(path,options);
  if(!active())return;
  if(!q)state.landmarks=result.places;
  showPlaceMatches(result.places,result.places.length?'':'No matches in NYC. Try a street address or landmark.');
 }catch(e){if(active())$('#place-status').textContent=e.message;}
}
function selectEndpoint(place,endpoint){
 if(!place||!endpoint)return;
 if(endpoint==='favorite'){nameFavorite(place,endpoint);return;}
 cancelPlaceSearch();
 setMainView('directions');
 const other=endpoint==='origin'?'destination':'origin';
 if(endpoint==='origin'){currentLocation.cancel();state.location={status:'idle'};}
 if(state[other]?.id===place.id)[state.origin,state.destination]=[state.destination,state.origin];
 else state[endpoint]=place;
 state.travelMode='all';
 sheet.close();state.modal=null;clearTrip();renderRoutes();drawRoute(false);planTrip();
}
function nameFavorite(place,endpoint){
 if(!place)return;
 cancelPlaceSearch();
 const label=state.favoritePlaces.find(item=>item.place.id===place.id)?.label||'';
 state.modal={type:'favorite',place,endpoint,query:$('#place-query')?.value||''};
 openSheet('Save place',`<form id="favorite-place-form"><p class="dialog-copy">${esc(place.name)}</p><label class="field-label" for="favorite-place-name">Name</label><input id="favorite-place-name" name="label" class="search-input" placeholder="Home, Work, or another name" value="${esc(label)}" maxlength="40" required></form>`,`<button type="button" class="text-button" data-action="back-to-place-search">Back</button><button class="primary" type="submit" form="favorite-place-form">Save place</button>`);
 $('#favorite-place-name').focus();
}
function updateFavorites(next){
 try{localStorage.setItem(favoritePlaceStorage,JSON.stringify(next));state.favoritePlaces=next;return true;}
 catch{toast('This browser couldn’t update saved places.');return false;}
}
function returnToPlaceSearch({endpoint,query}){
 if(endpoint==='favorite'){savedTrips();return;}
 choosePlace(endpoint,query);
}
function saveFavorite(label){
 const modal=state.modal;
 if(modal?.type!=='favorite'||!label)return;
 const {place}=modal;
 const next=[{label,place},...state.favoritePlaces.filter(item=>item.place.id!==place.id)].slice(0,30);
 if(!updateFavorites(next))return;
 returnToPlaceSearch(modal);toast(`${label} saved.`);
}

function preferences(draft=state.preferences,{fromLink=false}={}){
 state.modal={type:'preferences'};const p=draft,pace=(title,key)=>`<label><span>${title}</span><input type="number" name="${key}" inputmode="decimal" aria-label="${title} in miles per hour" min="4" max="18" step="0.1" placeholder="Auto" value="${esc(p[key]??'')}"><small>mph</small></label>`,range=(title,key,min,max,step,unit='')=>`<div class="range-row"><label for="${key}">${title}<output data-output="${key}">${key==='maxFareCents'?money(p[key]):p[key]+unit}</output></label><input id="${key}" name="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${p[key]}" data-unit="${unit}"></div>`;
 openSheet('Make it mine',`<form id="preferences-form"><section class="field-section"><span class="field-label">Your wheels, today</span><div class="segments"><label><input type="radio" name="bikeSource" value="citiBike" ${p.bikeSource==='citiBike'?'checked':''}>Citi Bike</label><label><input type="radio" name="bikeSource" value="ownBike" ${p.bikeSource==='ownBike'?'checked':''}>My own bike</label></div><label class="toggle-row" id="membership-row"><span>Annual Citi Bike member</span><input name="citiBikeMember" type="checkbox" ${p.citiBikeMember?'checked':''}></label><p class="hint" id="bike-policy"></p><div id="bike-paces"><div class="bike-pace-fields">${pace('Classic bike','classicBikePaceMph')}${pace('Low assist','lowAssistBikePaceMph')}</div><p class="hint">Use your average dock-to-dock pace, including stops and signals. Leave blank for automatic timing.</p></div></section><section class="field-section"><span class="field-label">Open to taking</span>${['bike','subway','bus'].map(m=>`<label class="toggle-row"><span>${icon(m)}${m==='bike'?'Bike':m==='subway'?'Subway':'Bus'}</span><input type="checkbox" name="mode-${m}" ${p.modes.includes(m)?'checked':''}></label>`).join('')}<label class="toggle-row"><span>Live transit predictions only</span><input type="checkbox" name="requireLiveTransit" ${p.requireLiveTransit?'checked':''}></label><p class="hint">${state.health?.feeds?.bus?.configured?'Bus Time is connected.':'Live bus predictions need a Bus Time API key. Turn off live-only to compare clearly labeled bus schedules.'}</p></section><section class="field-section"><label class="field-label" for="walking-pace">Walking pace</label><select id="walking-pace" name="walkingPace" class="search-input">${[["relaxed","Relaxed · 2.5 mph"],["standard","Standard · 3.0 mph"],["brisk","Brisk · 3.7 mph"]].map(([value,label])=>`<option value="${value}" ${(p.walkingPace||"brisk")===value?"selected":""}>${label}</option>`).join("")}</select><p class="hint">Pace changes walking paths, train connections and arrival estimates. Crossing time is included.</p></section><section class="field-section"><span class="field-label">Hard limits</span>${range('Estimated budget','maxFareCents',0,3000,100)}${range('Walking, total','maxWalkingMinutes',0,90,5,' min')}${range('Biking, total','maxBikingMinutes',0,90,5,' min')}${range('Transit transfers','maxTransfers',0,5,1)}</section><section class="field-section"><label class="toggle-row"><span>Use my own mix</span><input type="checkbox" name="custom" ${p.priority==='custom'?'checked':''}></label><div id="custom-weights" ${p.priority==='custom'?'':'hidden'}>${range('Save time','timeWeight',0,100,5)}${range('Save money','costWeight',0,100,5)}${range('Less time outside','outsideWeight',0,100,5)}${range('Less underground','undergroundWeight',0,100,5)}</div><p class="hint">Higher values give that priority more influence. Outdoor time and fares are estimates; your limits apply to those estimates.</p></section></form>`,`<button class="text-button" data-action="reset-preferences">Reset</button><button class="primary" data-action="apply-preferences">${fromLink?'Save bike paces':'Find my connections'} ${icon('arrow')}</button>`);bikeFields();
}
function bikeFields(){const f=$('#preferences-form');if(!f)return;const own=f.elements.bikeSource.value==='ownBike';$('#membership-row').hidden=own;$('#bike-paces').hidden=own;for(const key of bikePaceKeys)f.elements[key].disabled=own;f.elements['mode-bus'].disabled=own;$('#bike-policy').textContent=own?'Your bike stays with you on walks and subway rides. Buses are excluded. Carrying it on station stairs adds effort.':'Pickup bikes and return docks are checked. Annual members may see a low-assist e-bike option on long rides.';}
function applyPreferences(){
 const f=$('#preferences-form');
 if(!f.reportValidity())return;
 const d=new FormData(f),p={...state.preferences};
 for(const k of ['maxFareCents','maxWalkingMinutes','maxBikingMinutes','maxTransfers','timeWeight','costWeight','outsideWeight','undergroundWeight'])p[k]=Number(d.get(k));
 p.bikeSource=d.get('bikeSource');p.walkingPace=d.get('walkingPace');p.citiBikeMember=f.elements.citiBikeMember.checked;p.requireLiveTransit=f.elements.requireLiveTransit.checked;
 p.modes=['walk',...['bike','subway','bus'].filter(m=>f.elements['mode-'+m].checked)];
 p.priority=d.has('custom')?'custom':p.priority==='custom'?'fastest':p.priority;
 const paces=bikePaces(Object.fromEntries(bikePaceKeys.map(key=>[key,f.elements[key].value])));
 try{localStorage.setItem(bikePaceStorage,JSON.stringify(paces));}catch{}
 state.preferences={...p,...paces};
 sheet.close();state.modal=null;planTrip();
}
function journeyView(mode){
 const isNavigation=mode==='navigation';
 if(mode)app.dataset.journeyView=mode;
 else delete app.dataset.journeyView;
 $('#results-card').dataset.content=mode||'routes';
 $('#route-options').hidden=Boolean(mode);
 preview.hidden=mode!=='preview';
 navigationPanel.hidden=!isNavigation;
 $('#navigation-prompt').hidden=!isNavigation;
}

const legColor=leg=>leg.mode==='subway'&&/^[0-9a-f]{6}$/i.test(leg.routeColor)?'#'+leg.routeColor:
  ({walk:'#526a7b',subway:'#25815f',bus:'#2967a2',bike:'#3455bb'})[leg.mode];

function journeyEndpoint(label,name,time){
 return `<div class="journey-endpoint"><i aria-hidden="true"></i><div><small>${label}</small><strong>${esc(name)}</strong></div><time datetime="${esc(time)}">${clock(time)}</time></div>`;
}

function journeyLeg(r,leg,index){
 const ride=leg.mode==='subway'||leg.mode==='bus';
 const duration=mins(ride?Math.max(0,leg.duration-leg.waitingMinutes):leg.duration);
 const distance=leg.distanceMeters>=80?' · '+(leg.distanceMeters/1609.344).toFixed(1)+' mi':'';
 const fit=`<button class="journey-button journey-fit-leg" data-journey-leg="${index}" aria-label="Show this leg on the map">${icon('locate')}</button>`;
 const rail=`<span class="journey-rail" aria-hidden="true"><b>${icon(leg.mode)}</b></span>`;
 const count=leg.stopCount?leg.stopCount+(leg.stopCount===1?' stop':' stops'):'';
 const stops=leg.intermediateStops?.length?`<details><summary>${count} · ${duration} min ride</summary><ol>${leg.intermediateStops.map(stop=>`<li>${esc(stop.name)}</li>`).join('')}</ol></details>`:
   count?`<p>${count}</p>`:'';
 if(ride)return `<li class="journey-segment transit" style="--leg-color:${legColor(leg)}">${rail}<div class="journey-segment-body">
   <div class="journey-step"><div><small>Board at</small><strong>${esc(leg.from.name)}</strong></div><time datetime="${esc(leg.departureTime)}">${clock(leg.departureTime)}</time></div>
   <div class="journey-service">${lineBadges({...leg,lineOptions:null})}<span>${leg.headsign?'Toward '+esc(leg.headsign):duration+' min ride'}</span>${fit}</div>
   <p class="${leg.realtime?'live-note':''}">${leg.realtime?'Live departure':'Scheduled departure'}${leg.waitingMinutes>=1?' · '+mins(leg.waitingMinutes)+' min wait':''}</p>
   ${leg.mode==='subway'?trainChoices(r,index):''}${stops}
   <div class="journey-step journey-exit"><div><small>Get off at</small><strong>${esc(leg.to.name)}</strong></div><time datetime="${esc(leg.arrivalTime)}">${clock(leg.arrivalTime)}</time></div>
   </div></li>`;
 const lowAssist=leg.bikeRideType==='lowAssist';
 const docks=leg.bikePickup?`<p class="live-note">${lowAssist?`0 classic bikes · ${leg.bikePickup.ebikes} e-bikes`:`${leg.bikePickup.classicBikes} classic bikes`} · ${leg.bikeReturn.docks} return docks when checked</p>${lowAssist?'<p>Choose Low Assist at unlock if Citi Bike offers it. Bike counts can change.</p>':''}`:'';
 const setup=leg.setupMinutes>0?`<p>Includes ${mins(leg.setupMinutes)} min for pickup and return.</p>`:'';
 const steps=(leg.steps||[]).filter(step=>step.distance>5);
 const directions=steps.length?`<details><summary>Street directions</summary><ol>${steps.map(step=>{
  const turn=step.relativeDirection==='DEPART'?step.absoluteDirection:step.relativeDirection;
  return `<li>${esc(turn).replaceAll('_',' ').toLowerCase()} onto ${esc(step.streetName)} · ${Math.round(step.distance)} m${step.walkingBike?' · walk bike':''}</li>`;
 }).join('')}</ol></details>`:'';
 return `<li class="journey-segment ${leg.mode}" style="--leg-color:${legColor(leg)}">${rail}<div class="journey-segment-body">
   <div class="journey-step"><div><small>${duration} min${distance}</small><strong>${esc(leg.instruction)}</strong></div>${fit}</div>
   ${docks}${setup}${directions}</div></li>`;
}

function fitJourneyLeg(index){
 const leg=state.journey?.route?.legs[index];
 if(!leg?.coordinates?.length)return;
 mobileLayout.showMap();
 const bounds=L.latLngBounds(leg.coordinates.map(point=>[point.latitude,point.longitude]));
 map.fitBounds(bounds,{...mobileLayout.fitPadding(),maxZoom:17,animate:!matchMedia('(prefers-reduced-motion:reduce)').matches});
}

function detail(route,{focus=false,expand=false}={}){
 if(!route)return;
 const scroll=$('.journey-outline',preview)?.scrollTop||0;
 state.journey??={};
 state.journey.route=route;
 journeyView('preview');
 const toolbar=[['refresh-detail','Refresh this trip','refresh'],['journey-size','Resize journey outline','chevron']];
 const first=route.legs[0],last=route.legs.at(-1),modes=route.legs.map(leg=>`<span class="journey-mode">${leg.line?lineBadges(leg):icon(leg.mode)}${leg.line?'':`<b>${mins(leg.duration)} min</b>`}</span>`).join(`<span class="journey-mode-arrow" aria-hidden="true">${icon('chevron')}</span>`);
 preview.innerHTML=`<header class="journey-header"><button class="journey-button" data-action="journey-back" aria-label="Back to routes">${icon('back')} Routes</button><div class="journey-actions">${toolbar.map(([action,label,symbol])=>`<button class="journey-button ${action==='journey-size'?'journey-resize':''}" data-action="${action}" aria-label="${label}">${icon(symbol)}</button>`).join('')}</div></header>
  <div class="journey-summary"><h2 id="journey-title" tabindex="-1">${mins(route.minutes)} min</h2>
  <p><time datetime="${esc(route.arrivalTime)}">Arrive ${clock(route.arrivalTime)}</time> · ${money(route.fareCents)} est. · ${mins(route.outdoorMinutes)} min outside</p>
  <div class="journey-modes" aria-label="${esc(routeTitle(route))}">${modes}</div></div>
  <div class="journey-outline" tabindex="0" aria-label="Journey outline"><h3 class="visually-hidden">Journey outline</h3>
  ${first?journeyEndpoint('Start',first.from.name,route.departureTime):''}
  <ol class="journey-timeline">${route.legs.map((leg,index)=>journeyLeg(route,leg,index)).join('')}</ol>
  ${last?journeyEndpoint('Destination',last.to.name,route.arrivalTime):''}
  <p class="hint">${route.legs.some(leg=>leg.bikePickup)?`${esc(route.fareAssumption)}. `:''}Checked ${clock(route.generatedAt)}.</p></div>
  <footer class="journey-footer"><button class="primary" data-action="navigate" aria-label="Start navigation">${icon('navigate')} Start</button>
    <button class="journey-button" data-action="save" aria-label="Save this trip">${icon('bookmark')} Save</button>
    <button class="journey-button" data-action="share" aria-label="Share this route">${icon('share')} Share</button></footer>`;
 $('.journey-outline',preview).scrollTop=expand?0:scroll;
 if(expand)mobileLayout.showRoutes();
 drawRoute(expand);
 if(focus)$('#journey-title').focus({preventScroll:true});
}

function closeJourney({focus=true}={}){
 if(!state.journey)return;
 endNavigation({showPreview:false});
 state.journey=null;
 journeyView('');
 mobileLayout.showRoutes();
 drawRoute(false);
 if(focus)$(`[data-route="${state.selected}"]`)?.focus({preventScroll:true});
}
function saveTrip(){const id=state.origin.id+'|'+state.destination.id+'|'+state.preferences.bikeSource;if(state.saved.some(s=>s.id===id)){toast('This trip is already saved.');return;}const next=[{id,origin:state.origin,destination:state.destination,preferences:{...state.preferences}},...state.saved].slice(0,30);try{localStorage.setItem('crosstown.saved.v2',JSON.stringify(next));state.saved=next;toast('Trip saved. It will search fresh data when reopened.');}catch{toast('This browser couldn’t save the trip.');}}
function savedTrips(){
 state.modal={type:'saved'};
 const journeys=state.saved.map((s,i)=>`<div class="place-result-row"><button class="saved-trip" data-saved="${i}">${icon('bookmark')}<span><strong>${esc(s.origin.name)} → ${esc(s.destination.name)}</strong><small>${labels[s.preferences.priority]} · ${s.preferences.bikeSource==='ownBike'?'My bike':'Citi Bike'}</small></span></button><button class="place-bookmark" data-remove-saved="${i}" aria-label="Remove saved trip">${icon('close')}</button></div>`).join('');
 openSheet('Saved',`<section><h3 class="saved-section-title">Places</h3>${favoriteButtons('',true)}<button class="text-button add-favorite" data-place="favorite">Add a place</button></section><section><h3 class="saved-section-title">Trips</h3>${journeys||'<p class="hint">Open a route and tap the bookmark to save it.</p>'}</section>`);
}
async function sources(){
 state.modal={type:'sources'};openSheet('Live sources','<div class="loading"><i></i><span>Checking providers…</span></div>');
 try{const h=await api('/health');state.health=h;if(state.modal?.type!=='sources')return;
 const f=h.feeds,s=f.subway.filter(x=>!x.stale),latest=s.sort((a,b)=>b.sourceTimestamp.localeCompare(a.sourceTimestamp))[0];
 const routing=h.router.mode==='community'?`<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous data sources</a> · <a href="https://github.com/dahn821/crosstown-open" target="_blank" rel="noopener">Crosstown source</a></p><p>Transitous receives your trip coordinates for routing. Tap Refresh for a new plan.`:'OpenTripPlanner · MTA schedules · OpenStreetMap streets for all five boroughs.';
 openSheet('Live sources',`<div class="source-row"><div>NYC street routing <small class="${h.router.ready?'live-note':'amber'}">${h.router.ready?'Connected':'Starting'}</small></div><p>${routing}</p></div><div class="source-row"><div>Subway predictions <small class="${s.length?'live-note':'amber'}">${s.length} of 8 feeds fresh</small></div><p>Latest report ${clock(latest?.sourceTimestamp)}. A route says live only when a reachable train reports both your boarding and alighting stops.</p></div><div class="source-row"><div>Citi Bike availability <small class="${f.bikes.stale?'amber':'live-note'}">${f.bikes.stale?'Stale / unavailable':f.bikes.stations+' stations'}</small></div><p>Provider report ${clock(f.bikes.sourceTimestamp)}. Current classic bikes and return docks are checked; arrival availability is not guaranteed.</p></div><div class="source-row"><div>Bus Time <small class="${f.bus.configured&&!f.bus.stale?'live-note':'amber'}">${f.bus.configured?(f.bus.stale?'Unavailable':'Connected'):'API key needed'}</small></div><p>${f.bus.configured?'Bus predictions refresh with the other feeds.':'Turn off live-only transit to see scheduled buses.'}</p>${h.localSetupAvailable?`<button class="primary" style="margin-top:12px" data-action="bus-setup">${f.bus.configured?'Update Bus Time key':'Connect Bus Time'}</button>`:''}</div><p class="hint" style="margin-top:18px">Street times, outside exposure and fares are estimates. Above-ground estimates use MTA station structures.</p><a class="source-link" href="https://register.developer.obanyc.com/" target="_blank" rel="noopener">Request a Bus Time key ↗</a>`);updateFreshness();}
 catch(e){openSheet('Live sources',`<div class="empty"><h3>Server connection needed.</h3><p>${esc(e.message)}</p><p class="hint">Run Start Crosstown.command from the downloaded project. The live app opens at localhost:4173.</p></div>`);}
}
function busSetup(){
 state.modal={type:'bus-setup'};
 openSheet('Connect Bus Time',`<h3>One key.<br>Live bus connections.</h3><p class="dialog-copy">Paste the developer key from MTA’s email. We’ll check it before changing your connection.</p><form id="bus-setup-form"><label for="bus-api-key" class="field-label">Bus Time developer key</label><input id="bus-api-key" class="key-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" required placeholder="Paste your MTA key"><p class="hint" style="margin-top:12px">Saved privately on this Crosstown server. The key is never included in route results or saved trips.</p><p id="bus-setup-message" class="hint amber" role="status" style="margin-top:14px"></p></form><a class="source-link" href="https://register.developer.obanyc.com/" target="_blank" rel="noopener">Request a key from MTA ↗</a>`,`<button class="text-button" data-action="sources">Back</button><button class="primary" type="submit" form="bus-setup-form" id="bus-connect-button">Connect Bus Time</button>`);
 $('#bus-api-key').focus();
}
async function connectBus(){
 const field=$('#bus-api-key'),button=$('#bus-connect-button');if(!field?.value.trim()||!button||button.disabled)return;
 const key=field.value;field.value='';button.disabled=true;button.textContent='Checking MTA…';$('#bus-setup-message').textContent='';
 try{
  await api('/setup/bus-time',{method:'POST',body:JSON.stringify({apiKey:key})});
  if(state.modal?.type!=='bus-setup')return;
  await sources();toast('Live bus predictions connected.');await planTrip();
 }catch(e){
  if(state.modal?.type!=='bus-setup')return;
  $('#bus-setup-message').textContent=e.message;button.disabled=false;button.textContent='Connect Bus Time';
 }
}
document.addEventListener('submit',event=>{if(event.target.id==='bus-setup-form'){event.preventDefault();connectBus();}});

function lookupRide(leg,signal){
 const params=new URLSearchParams({mode:leg.mode,line:leg.line,trip:leg.tripId,from:leg.boardStopId,to:leg.alightStopId,departure:leg.departureTime});
 return api('/ride?'+params,{signal});
}

function setText(id,text){
 const element=document.getElementById(id);
 if(element.textContent!==text)element.textContent=text;
}

const distanceLabel=meters=>meters>=400?`${(meters/1609.344).toFixed(1)} mi`:`${Math.max(25,Math.round(meters*3.28084/25)*25)} ft`;

function currentRideTime(update,boarding){
 const {ride,leg}=update;
 const live=ride?.[boarding?'departureTime':'arrivalTime'];
 if(live&&Date.now()-Date.parse(ride.reportedAt)<=180000)return {time:live,label:'Live prediction'};
 const time=leg[boarding?'departureTime':'arrivalTime'];
 const recent=leg.realtime&&!ride&&Date.now()-Date.parse(leg.predictionReportedAt)<=180000;
 return {time,label:recent?'Live prediction':leg.realtime?'Last trip estimate':'Scheduled'};
}

function navigationCue(update){
 const {phase,leg,fix,offRoute,ride,distanceToTurn}=update;
 if(phase==='arrived')return {icon:'check',title:'You’ve arrived',context:state.destination.name,confirm:'',replan:false};
 if(phase==='pickup')return {icon:'bike',title:`Pick up a Citi Bike at ${leg.bikePickup.name}`,context:leg.bikeRideType==='lowAssist'?'Choose Low Assist in the Citi Bike app if offered.':'Unlock a classic bike at the dock.',confirm:'I have the bike',replan:false};
 if(phase==='return')return {icon:'dock',title:`Return the bike at ${leg.bikeReturn.name}`,context:'Confirm once the bike is locked in.',confirm:'Bike returned',replan:false};
 if(phase==='board'||phase==='ride'){
  const boarding=phase==='board',prediction=currentRideTime(update,boarding);
  const missed=boarding&&Date.now()-Date.parse(prediction.time)>60000;
  const context=ride?.status==='changed'?'MTA reports a change to this trip.':missed?'This departure may have passed.':`${prediction.label} · ${boarding?'depart':'arrive'} ${clock(prediction.time)}`;
  return {icon:leg.mode,title:boarding?`Board the ${leg.line} at ${leg.from.name}`:`Get off at ${leg.to.name}`,
   context,confirm:boarding?'I boarded':'I got off',replan:ride?.status==='changed'||missed};
 }
 if(offRoute)return {icon:'locate',title:'You’re away from this route',context:'Return to the highlighted path or find a route from here.',confirm:'',replan:true};
 if(update.joining)return {icon:'locate',title:'Join the highlighted path',context:`Start near ${leg.from.name}.`,confirm:'',replan:false};
 const turn=fix?update.turn:null;
 const title=turn?.instruction||leg.instruction;
 const symbol=turn?.instruction.includes(' left')?'turnLeft':turn?.instruction.includes(' right')?'turnRight':leg.mode;
 const distance=fix&&distanceToTurn>15?(turn?`In ${distanceLabel(distanceToTurn)}`:`${distanceLabel(distanceToTurn)} to next stop`):'';
 return {icon:symbol,title,distance,context:turn?`Toward ${leg.to.name}`:'Follow the highlighted path.',
  confirm:!update.hasPath||(!fix&&update.locationMessage)?'Finish this leg':'',replan:false};
}

function positionOnMap(journey,fix){
 if(!fix){journey.marker?.getElement()?.classList.add('stale');return;}
 if(journey.markerTimestamp===fix.timestamp)return;
 const point=[fix.latitude,fix.longitude];
 const markerIcon=L.divIcon({className:'navigation-position',html:`<span>${fix.heading==null?'':`<i style="transform:rotate(${fix.heading-45}deg)">${icon('navigate')}</i>`}</span>`,iconSize:[26,26],iconAnchor:[13,13]});
 const initial=!journey.marker;
 if(initial)journey.marker=L.marker(point,{icon:markerIcon,interactive:false,keyboard:false,zIndexOffset:1000}).addTo(navigationMarkers);
 else journey.marker.setLatLng(point).setIcon(markerIcon);
 journey.markerTimestamp=fix.timestamp;
 if(journey.following){
  if(initial)centerNavigation(fix);
  else map.panInside(point,{...mobileLayout.fitPadding(),animate:false});
 }
}

function centerNavigation(fix){
 const {paddingTopLeft,paddingBottomRight}=mobileLayout.fitPadding();
 const zoom=Math.max(17,map.getZoom());
 const offset=L.point(paddingTopLeft).subtract(L.point(paddingBottomRight)).divideBy(2);
 const center=map.project([fix.latitude,fix.longitude],zoom).subtract(offset);
 map.setView(map.unproject(center,zoom),zoom,{animate:false});
}

function updateNavigation(journey,update){
 if(state.journey!==journey)return;
 const cue=navigationCue(update);
 const symbol=$('#navigation-symbol');
 if(symbol.dataset.symbol!==cue.icon){symbol.innerHTML=icon(cue.icon);symbol.dataset.symbol=cue.icon;}
 setText('navigation-distance',cue.distance||'');
 setText('navigation-instruction',cue.title);
 setText('navigation-context',cue.context);
 setText('navigation-destination',state.destination.name);
 setText('navigation-progress',update.phase==='arrived'?'Trip complete':`Leg ${update.index+1} of ${journey.route.legs.length} · planned arrival ${clock(journey.route.arrivalTime)}`);
 setText('navigation-signal',update.phase==='arrived'?'':update.locationMessage||(update.fix?'GPS active':'Finding your location…'));
 const confirm=$('[data-action="nav-confirm"]');
 confirm.hidden=!cue.confirm;
 if(confirm.textContent!==cue.confirm)confirm.textContent=cue.confirm;
 $('[data-action="nav-replan"]').hidden=!cue.replan;
 $('[data-action="nav-follow"]').hidden=update.phase==='arrived';
 $('[data-action="nav-end"]').textContent=update.phase==='arrived'?'Done':'End';
 if(journey.stepIndex!==update.index){journey.stepIndex=update.index;drawRoute(false);}
 positionOnMap(journey,update.fix);
}

function startNavigation(){
 const journey=state.journey;
 if(!journey||journey.navigator)return;
 currentLocation.cancel();
 journey.following=true;
 journey.navigator=createLiveNavigation({route:journey.route,lookupRide,onUpdate:update=>updateNavigation(journey,update)});
 journeyView('navigation');
 mobileLayout.showNavigation();
 vehicleMap.setSuspended(true);
 $('[data-action="nav-follow"]').setAttribute('aria-pressed','true');
 journey.navigator.start();
 $('#navigation-instruction').focus({preventScroll:true});
}

function endNavigation({showPreview=true}={}){
 const journey=state.journey;
 if(!journey?.navigator)return;
 journey.navigator.stop();
 delete journey.navigator;
 delete journey.marker;
 delete journey.markerTimestamp;
 delete journey.stepIndex;
 navigationMarkers.clearLayers();
 vehicleMap.setSuspended(false);
 if(showPreview)detail(journey.route,{focus:true,expand:true});
}

function followNavigation(){
 const journey=state.journey;
 if(!journey?.navigator)return;
 journey.following=true;
 $('[data-action="nav-follow"]').setAttribute('aria-pressed','true');
 const fix=journey.navigator.snapshot().fix;
 if(fix)centerNavigation(fix);
 else journey.navigator.retryLocation();
}

function replanNavigation(){
 const navigation=state.journey?.navigator;
 if(!navigation)return;
 const fix=navigation.snapshot().fix;
 if(!fix){navigation.retryLocation();toast('A precise location is needed to search from here.');return;}
 state.origin={id:CURRENT_LOCATION_ID,name:'Current location',neighborhood:'Your device location',coordinate:{latitude:fix.latitude,longitude:fix.longitude},selectable:true};
 state.timing={mode:'now',time:null};
 state.travelMode='all';
 void planTrip();
}

async function share(){const r=state.journey?.route;if(!r)return;const text=`Crosstown: ${state.origin.name} → ${state.destination.name}. ${routeTitle(r)}, about ${mins(r.minutes)} min, arrive ${clock(r.arrivalTime)}, estimated ${money(r.fareCents)}. Checked ${clock(r.generatedAt)}. ${location.origin}`;try{if(navigator.share)await navigator.share({text,title:'Crosstown route'});else{await navigator.clipboard.writeText(text);toast('Route copied.');}}catch(e){if(e.name!=='AbortError')toast('Sharing is unavailable in this browser.');}}
function departure(){
 state.modal={type:'departure'};
 const selected=state.timing.mode,value=nyLocalInput(state.timing.time||Date.now()+15*60000);
 openSheet('When are you going?',`<form id="timing-form"><div class="segments">${[['now','Leave now'],['departAt','Depart at'],['arriveBy','Arrive by']].map(([mode,title])=>`<label><input type="radio" name="timeMode" value="${mode}" ${mode===selected?'checked':''}>${title}</label>`).join('')}</div><div id="custom-time" ${selected==='now'?'hidden':''}><label class="field-label" for="trip-date-time">New York date and time</label><input id="trip-date-time" class="timing-input" name="time" type="datetime-local" value="${value}" min="${nyLocalInput()}" max="${nyLocalInput(Date.now()+14*86400000)}" required ${selected==='now'?'disabled':''}><label class="toggle-row"><span>Include scheduled transit</span><input name="includeSchedules" type="checkbox" ${state.preferences.requireLiveTransit?'':'checked'}></label><p class="hint">MTA reports trains and buses currently in service. Future trips need published schedules. Each transit leg says live or scheduled. Bike counts show availability now.</p></div><p class="hint">All times are New York time. Choose a time within the next 14 days.</p><p id="timing-error" class="hint amber" role="status"></p></form>`,`<button class="primary" type="submit" form="timing-form">Apply time</button>`);
}
function applyDeparture(){
 const form=$('#timing-form');if(!form?.reportValidity())return;
 const mode=form.elements.timeMode.value,time=mode==='now'?null:nyTimeToISO(form.elements.time.value);
 if(mode!=='now'&&(!time||Date.parse(time)<Date.now()-60000||Date.parse(time)>Date.now()+14*86400000)){$('#timing-error').textContent='Choose a valid New York time within the next 14 days.';return;}
 state.timing={mode,time};if(mode!=='now')state.preferences.requireLiveTransit=!form.elements.includeSchedules.checked;
 sheet.close();state.modal=null;planTrip();
}
async function refreshDetail(){
 const journey=state.journey;
 if(state.loading||!journey||journey.navigator)return;
 const button=$('[data-action="refresh-detail"]');
 button.disabled=true;
 const id=journey.route.id;
 await planTrip({quiet:true});
 if(state.journey!==journey||journey.navigator)return;
 button.disabled=false;
 if(state.error){toast(state.error);return;}
 const current=currentRoutes().find(route=>route.id===id);
 if(current)detail(current);
 else{closeJourney();toast('This connection changed. Choose a current route.');}
}
function setMainView(view){
 if(state.mainView===view||state.journey?.navigator)return;
 vehicleTracking.close();
 if(state.journey)closeJourney({focus:false});
 state.mainView=view;app.dataset.mainView=view;
 for(const b of document.querySelectorAll('[data-live-view]'))b.setAttribute('aria-pressed',String(b.dataset.liveView===view));
 liveExplore.setView(view);
 map.invalidateSize();
 drawRoute(view==='directions');
}
document.addEventListener('submit',event=>{
 if(event.target.id==='timing-form'){event.preventDefault();applyDeparture();}
 if(event.target.id==='preferences-form'){event.preventDefault();applyPreferences();}
 if(event.target.id==='favorite-place-form'){event.preventDefault();saveFavorite(event.target.elements.label.value.trim());}
});
document.addEventListener('change',event=>{
 if(event.target.name!=='timeMode')return;
 const form=$('#timing-form'),custom=event.target.value!=='now';$('#custom-time').hidden=!custom;form.elements.time.disabled=!custom;
 if(custom)form.elements.includeSchedules.checked=true;
});

document.addEventListener('click',event=>{
 const b=event.target.closest('button,a.brand');if(!b)return;
 if(b.dataset.departureChoice){const option=state.response?.alternativeRoutes?.[b.dataset.departureChoice];if(!option||!canChooseDeparture(option)){toast('Refresh for current, reachable departures.');return;}departureSelections[option.groupId]=option.choiceId;const selected={...option,id:option.groupId};renderRoutes();detail(selected);toast('Departure selected. Arrival and transfers updated.');return;}
 if(b.dataset.liveView){setMainView(b.dataset.liveView);return;}
 if(b.dataset.action==='refresh-detail'){refreshDetail();return;}
 if(b.matches('.brand')){event.preventDefault();setMainView('directions');return;}
 if(b.dataset.travelMode){state.travelMode=b.dataset.travelMode;state.selected=0;renderRoutes();mobileLayout.showRoutes();drawRoute();return;}
 if(b.dataset.priority){state.preferences.priority=b.dataset.priority;planTrip();return;}
 if(b.dataset.place){choosePlace(b.dataset.place);return;}
 if(b.dataset.selectPlace!=null){selectEndpoint(state.places[Number(b.dataset.selectPlace)],state.modal?.endpoint);return;}
 if(b.dataset.favoriteResult!=null){nameFavorite(state.places[Number(b.dataset.favoriteResult)],state.modal?.endpoint);return;}
 if(b.dataset.selectFavorite!=null){selectEndpoint(state.favoritePlaces[Number(b.dataset.selectFavorite)]?.place,state.modal?.endpoint??'destination');return;}
 if(b.dataset.removeFavorite!=null){if(updateFavorites(state.favoritePlaces.filter((_,i)=>i!==Number(b.dataset.removeFavorite))))savedTrips();return;}
 if(b.dataset.route!=null){state.selected=Number(b.dataset.route);renderRoutes();detail(currentRoutes()[state.selected],{focus:true,expand:true});return;}
 if(b.dataset.journeyLeg!=null){fitJourneyLeg(Number(b.dataset.journeyLeg));return;}
 if(b.dataset.saved!=null){setMainView('directions');currentLocation.cancel();state.location={status:'idle'};const s=state.saved[Number(b.dataset.saved)];state.origin=s.origin;state.destination=s.destination;state.preferences={...defaults(),...s.preferences,...bikePaces(state.preferences)};state.travelMode='all';state.timing={mode:'now',time:null};sheet.close();state.modal=null;if(state.origin.id===CURRENT_LOCATION_ID)useCurrentLocation();else planTrip();return;}
 if(b.dataset.removeSaved!=null){state.saved.splice(Number(b.dataset.removeSaved),1);try{localStorage.setItem('crosstown.saved.v2',JSON.stringify(state.saved));savedTrips();}catch{toast('Couldn’t update saved trips.');}return;}
 switch(b.dataset.action){
  case'early-route':detail(state.earlyRoute,{focus:true,expand:true});break;
  case'journey-back':closeJourney();break;
  case'journey-size':mobileLayout.resizeJourney();break;
  case'navigate':startNavigation();break;
  case'nav-end':endNavigation();break;
  case'nav-follow':followNavigation();break;
  case'nav-confirm':state.journey?.navigator?.confirm();break;
  case'nav-replan':replanNavigation();break;
  case'close':cancelPlaceSearch();sheet.close();state.modal=null;break;
  case'back-to-place-search':if(state.modal?.type==='favorite')returnToPlaceSearch(state.modal);break;
  case'preferences':preferences();break;
  case'apply-preferences':applyPreferences();break;
  case'reset-preferences':preferences(defaults());break;
  case'current-location':useCurrentLocation();break;
  case'refresh':refreshTrip();break;
  case'swap':currentLocation.cancel();state.location={status:'idle'};state.travelMode='all';[state.origin,state.destination]=[state.destination,state.origin];refreshTrip();break;
  case'fit':drawRoute();break;
  case'sources':sources();break;
  case'bus-setup':busSetup();break;
  case'saved':savedTrips();break;
  case'save':saveTrip();break;
  case'share':share();break;
  case'departure':departure();break;
 }
});
document.addEventListener('input',event=>{
 const x=event.target;
 if(x.id==='place-query'){
  cancelPlaceSearch();
  const value=x.value.trim();
  if(value.length<2)findPlaces(value);
  else{renderPlaceFavorites(value);showPlaceMatches([],'Searching NYC…');searchTimer=setTimeout(()=>findPlaces(value),150);}
 }
 if(x.type==='range'){const out=$(`[data-output="${x.name}"]`);if(out)out.textContent=x.name==='maxFareCents'?money(Number(x.value)):x.value+x.dataset.unit;}
});
document.addEventListener('change',event=>{if(event.target.name==='bikeSource')bikeFields();if(event.target.name==='custom')$('#custom-weights').hidden=!event.target.checked;});
sheet.addEventListener('cancel',()=>{cancelPlaceSearch();state.modal=null;});sheet.addEventListener('click',event=>{if(event.target!==sheet)return;const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom){cancelPlaceSearch();sheet.close();state.modal=null;}});
hydrate();currentLocation.request();initMap();drawRoute(false);
function openLinkedBikePaces(){
 const sharedPaces=linkedBikePaces(location.hash);
 if(!sharedPaces)return;
 preferences({...state.preferences,bikeSource:'citiBike',...sharedPaces},{fromLink:true});
 history.replaceState(history.state,'',location.pathname+location.search);
}
openLinkedBikePaces();
window.addEventListener('hashchange',openLinkedBikePaces);
try{const [d,health]=await Promise.all([api('/places'),api('/health?feeds=0')]);state.landmarks=d.places;state.health=health;if(health.router.mode==='community'){app.dataset.hosted='true';map.attributionControl.addAttribution('<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>');}else state.destination??=d.places.find(p=>p.id==='ues')??d.places[1];renderRoutes();if(new URLSearchParams(location.search).get('setup')==='bus-time'&&state.health.localSetupAvailable)busSetup();await planTrip();}catch(e){state.loading=false;state.error=e.message;renderRoutes();}
setInterval(()=>{updateFreshness();if(document.hidden)return;if(state.mainView==='directions'&&state.health?.router?.ready&&state.health.router.mode!=='community'&&!sheet.open&&!state.journey&&!state.loading&&state.origin)refreshTrip({quiet:true});},30000);
window.addEventListener('resize',()=>{map?.invalidateSize();drawRoute(false);});
