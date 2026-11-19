import * as L from 'leaflet';
import {maplibreGL} from './vendor/maplibre-leaflet/leaflet-maplibre-gl.mjs';
import {icon} from './icons.mjs';
import {defaults,labels,routeTitle} from './preferences.mjs';
import {nyLocalInput,nyTimeToISO,timingPayload,timingLabel} from './timing.mjs';
import {attachVehicleMap} from './vehicles.mjs';
import {attachMobileLayout} from './mobile-layout.mjs';
import {CURRENT_LOCATION_ID,createCurrentLocationLookup} from './current-location.mjs';
import {deviceLocation} from './location-startup.mjs';
import {departureOptions,resolveDeparture,canChooseDeparture} from './transit-choices.mjs';
import {createLiveNavigation} from './live-navigation.mjs';
const $=(s,root=document)=>root.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mins=n=>Math.ceil(n),money=c=>c===0?'Included':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100),clock=s=>s?new Date(s).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}):'—';
const state={origin:null,destination:null,location:{status:'idle'},preferences:defaults(),response:null,selected:0,loading:false,error:null,health:null,places:[],saved:[],modal:null,journey:null,timing:{mode:'now',time:null},travelMode:'all'};
const sheet=$('#sheet'),app=$('#app'),preview=$('#journey-preview'),navigationPanel=$('#navigation-controls');
let searchId=0,searchTimer,placeSearchId=0,toastTimer,map,layers,abort,vehicleMap,mobileLayout,navigationMarkers;
const departureSelections={};let departureRequestKey="";
function lineBadges(leg){
 const choices=leg.mode==='subway'&&leg.lineOptions?.length?leg.lineOptions:[{line:leg.line,routeColor:leg.routeColor}];
 return choices.filter(option=>option.line).map(option=>`<span class="line-badge ${leg.mode==='bus'?'bus':''}" style="background:#${/^[0-9a-f]{6}$/i.test(option.routeColor)?option.routeColor:leg.mode==='bus'?'3678c7':'239a68'};${['FCCC0A','F9B514'].includes(option.routeColor?.toUpperCase())?'color:#171c25':''}">${esc(option.line)}</span>`).join('');
}
function trainChoices(route,index){
 const options=departureOptions(route,index,state.response);
 return `<details class="train-choices"><summary>Choose a train</summary>${options.length?options.map(option=>`<button class="departure-choice" data-departure-choice="${esc(option.choiceId)}" aria-pressed="${option.choiceId===route.choiceId}"><span><strong>${esc(option.legs[index].line)} · ${clock(option.legs[index].departureTime)}</strong><small>Arrive ${clock(option.arrivalTime)} · ${mins(option.minutes)} min total</small></span><span>${option.choiceId===route.choiceId?'✓':'Choose'}</span></button>`).join(''):'<p class="hint">Refresh this trip for current departures.</p>'}</details>`;
}
try{const s=JSON.parse(localStorage.getItem('crosstown.saved.v2')||'[]');state.saved=Array.isArray(s)?s.filter(x=>x.origin?.coordinate&&x.destination?.coordinate&&x.preferences).slice(0,30):[];}catch{}
async function api(url,options={}){const r=await fetch('/api'+url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const d=await r.json();if(!r.ok)throw Error(d.error||'The request could not be completed.');return d;}
function toast(s){clearTimeout(toastTimer);$('#toast').textContent=s;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3000);}
function hydrate(root=document){for(const n of root.querySelectorAll('[data-icon]'))n.innerHTML=icon(n.dataset.icon);}
function updateFields(){$('#origin-label').textContent=state.location.status==='loading'&&!state.origin?'Finding your location…':state.origin?.name||'Current location';$('#destination-label').textContent=state.destination?.name||'Choose a destination';$('#departure-label').textContent=timingLabel(state.timing);$('[data-action="swap"]').disabled=!state.origin||!state.destination;for(const b of document.querySelectorAll('[data-priority]')){const active=b.dataset.priority===state.preferences.priority;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);}$('#custom-note').hidden=state.preferences.priority!=='custom';}
function clearTrip(){searchId++;abort?.abort();state.loading=false;state.response=null;state.error=null;$('[data-action="refresh"]').disabled=false;}
const currentLocation=createCurrentLocationLookup({source:deviceLocation,onUpdate:(update,options)=>{
 state.location=update;
 if(update.place){const first=!state.origin;state.origin=update.place;renderRoutes();drawRoute(first);planTrip(options);}
 else {if(update.status==='error'){state.origin=null;clearTrip();drawRoute(false);}renderRoutes();}
}});
function useCurrentLocation(){closeJourney({focus:false});currentLocation.cancel();state.origin=null;clearTrip();if(state.modal?.type==='place'){sheet.close();state.modal=null;}currentLocation.request();}
function refreshTrip(options={}){if(state.origin?.id===CURRENT_LOCATION_ID||!state.origin)return currentLocation.request(options);return planTrip(options);}
function currentRoutes(){
 const mode=state.travelMode,all=state.response?.routes||[];
 let routes=all;
 if(mode==='all'){
  if(state.preferences.priority==='sheltered')routes=all.filter(route=>route.legs.some(leg=>leg.mode==='subway'||leg.mode==='bus')&&route.legs.every(leg=>leg.mode!=='bike'));
 }else{
  routes=state.response?.routeGroups?.[mode]??all.filter(route=>{
   if(mode==='walk')return route.legs.every(leg=>leg.mode==='walk');
   return route.legs.some(leg=>leg.mode===mode)&&(mode==='bike'||route.legs.every(leg=>leg.mode===mode||leg.mode==='walk'));
  });
 }
 return routes.map(route=>resolveDeparture(route,state.response,departureSelections));
}
async function planTrip({quiet=false}={}){
 if(!quiet&&state.journey)closeJourney({focus:false});
 if(!state.origin||!state.destination)return;const key=JSON.stringify([state.origin.id,state.destination.id,state.preferences,state.timing]);if(key!==departureRequestKey){for(const id of Object.keys(departureSelections))delete departureSelections[id];departureRequestKey=key;}const id=++searchId;abort?.abort();abort=new AbortController();state.loading=true;state.error=null;
 if(!quiet){state.response=null;state.selected=0;renderRoutes();drawRoute();}$('[data-action="refresh"]').disabled=true;
 try{const request={origin:state.origin,destination:state.destination,preferences:state.preferences,...timingPayload(state.timing)};const r=await api('/plan',{method:'POST',body:JSON.stringify(request),signal:abort.signal});if(id!==searchId)return;const previous=currentRoutes()[state.selected]?.id;state.response=r;for(const key of Object.keys(departureSelections))if(!r.alternativeRoutes?.[departureSelections[key]])delete departureSelections[key];state.health={...state.health,router:r.router??state.health?.router,feeds:r.feedStatus};state.selected=Math.max(0,currentRoutes().findIndex(x=>x.id===previous));}
 catch(e){if(id!==searchId||e.name==='AbortError')return;state.error=e.message;state.response=null;}
 if(id!==searchId)return;state.loading=false;$('[data-action="refresh"]').disabled=false;renderRoutes();drawRoute(!quiet);updateFreshness();
}
function renderRoutes(){
 updateFields();const list=$('#route-list');for(const b of document.querySelectorAll('[data-travel-mode]')){const active=b.dataset.travelMode===state.travelMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
 const mode=state.travelMode,sheltered=mode==='all'&&state.preferences.priority==='sheltered';
 const description={subway:'Trips where the subway accounts for most of the ride time.',bus:'Trips where buses account for most of the ride time.',walk:'Walking routes within your walking limit.',bike:'Routes that include a bike ride.'};
 const context=$('#mode-context');
 context.textContent=state.response?.partialSearch?'Some route searches could not finish. Refresh to compare all options.':sheltered?'Subway and bus trips ranked by estimated time outside.':description[mode]||'';
 context.hidden=!context.textContent;
 if(!state.origin||!state.destination){const locating=state.location.status==='loading';$('#results-subtitle').textContent=locating?'Finding your current location':!state.origin?'Choose a start to find routes':'Choose a destination';list.innerHTML=`<div class="empty">${icon('locate')}<h3>${locating?'Finding your location…':!state.origin?'Start where you are.':'Where to?'}</h3><p>${esc(state.location.message||(locating?'Allow location access to find routes from where you are.':'Use your current location or choose a starting address.'))}</p>${!locating?'<button class="primary" data-action="current-location">Use current location</button>':''}<button class="text-button" data-place="${state.origin?'destination':'origin'}">Choose ${state.origin?'a destination':'a start'}</button></div>`;return;}
 if(state.loading&&!state.response){$('#results-subtitle').textContent='Checking connections…';list.innerHTML='<div class="loading"><i></i><strong>Looking beyond the nearest station</strong><span>Checking service times, bike docks and streets.</span></div>';return;}
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
 try{
   const gl=maplibreGL({style:location.origin+'/basemap/styles/positron',attribution:'<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',interactive:false}).addTo(map);
   gl.getMaplibreMap().on('idle',()=>$('#map').dataset.ready='vector');
   gl.getMaplibreMap().on('error',e=>{console.warn('Vector map:',e.error?.message);if(!$('#map').dataset.ready){map.removeLayer(gl);fallback();}});
 }catch(e){console.warn('Vector map:',e.message);fallback();}
 L.control.zoom({position:'bottomright'}).addTo(map);layers=L.featureGroup().addTo(map);
 navigationMarkers=L.layerGroup().addTo(map);
 vehicleMap=attachVehicleMap({map,L,api,getRoute:()=>state.journey?.route||currentRoutes()[state.selected]});
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
 const journey=state.journey,r=journey?.route||currentRoutes()[state.selected],caption=$('#map-caption');
 caption.hidden=!r;
 if(r){
  for(const [index,leg] of r.legs.entries()){
   const walk=leg.mode==='walk',completed=journey?.navigator&&index<(journey.stepIndex??0);
   const color=leg.mode==='bike'?'#2d5bff':leg.mode==='subway'?(/^[0-9a-f]{6}$/i.test(leg.routeColor)?'#'+leg.routeColor:'#25815f'):leg.mode==='bus'?'#3678c7':'#496d88';
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
async function choosePlace(endpoint){state.modal={type:'place',endpoint};openSheet(endpoint==='origin'?'Where are you starting?':'Where to?',`<input id="place-query" class="search-input" type="search" placeholder="Search a place, restaurant or address" aria-label="Search NYC places">${endpoint==='origin'?`<button class="place-result" data-action="current-location">${icon('locate')}<span><strong>Use current location</strong><small>Start from your device’s location</small></span></button>`:''}<div id="place-results"><p class="hint">Search NYC restaurants, addresses, landmarks or stations.</p></div>`);$('#place-query').focus();await findPlaces('');}
async function findPlaces(q){const id=++placeSearchId;try{const d=await api('/places?q='+encodeURIComponent(q));if(id!==placeSearchId||state.modal?.type!=='place')return;state.places=d.places;$('#place-results').innerHTML=d.places.length?d.places.map((p,i)=>`<button class="place-result" data-select-place="${i}">${icon('pin')}<span><strong>${esc(p.name)}</strong><small>${esc(p.neighborhood)}</small></span>${icon('arrow')}</button>`).join(''):'<p class="hint">No matches in NYC. Try a street address or landmark.</p>';}catch(e){if(id===placeSearchId&&$('#place-results'))$('#place-results').innerHTML=`<p class="hint">${esc(e.message)}</p>`;}}

function preferences(draft=state.preferences){
 state.modal={type:'preferences'};const p=draft,range=(title,key,min,max,step,unit='')=>`<div class="range-row"><label for="${key}">${title}<output data-output="${key}">${key==='maxFareCents'?money(p[key]):p[key]+unit}</output></label><input id="${key}" name="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${p[key]}" data-unit="${unit}"></div>`;
 openSheet('Make it mine',`<form id="preferences-form"><section class="field-section"><span class="field-label">Your wheels, today</span><div class="segments"><label><input type="radio" name="bikeSource" value="citiBike" ${p.bikeSource==='citiBike'?'checked':''}>Citi Bike</label><label><input type="radio" name="bikeSource" value="ownBike" ${p.bikeSource==='ownBike'?'checked':''}>My own bike</label></div><label class="toggle-row" id="membership-row"><span>Annual Citi Bike member</span><input name="citiBikeMember" type="checkbox" ${p.citiBikeMember?'checked':''}></label><p class="hint" id="bike-policy"></p></section><section class="field-section"><span class="field-label">Open to taking</span>${['bike','subway','bus'].map(m=>`<label class="toggle-row"><span>${icon(m)}${m==='bike'?'Bike':m==='subway'?'Subway':'Bus'}</span><input type="checkbox" name="mode-${m}" ${p.modes.includes(m)?'checked':''}></label>`).join('')}<label class="toggle-row"><span>Live transit predictions only</span><input type="checkbox" name="requireLiveTransit" ${p.requireLiveTransit?'checked':''}></label><p class="hint">${state.health?.feeds?.bus?.configured?'Bus Time is connected.':'Live bus predictions need a Bus Time API key. Turn off live-only to compare clearly labeled bus schedules.'}</p></section><section class="field-section"><label class="field-label" for="walking-pace">Walking pace</label><select id="walking-pace" name="walkingPace" class="search-input">${[["relaxed","Relaxed · 2.5 mph"],["standard","Standard · 3.0 mph"],["brisk","Brisk · 3.7 mph"]].map(([value,label])=>`<option value="${value}" ${(p.walkingPace||"brisk")===value?"selected":""}>${label}</option>`).join("")}</select><p class="hint">Pace changes walking paths, train connections and arrival estimates. Crossing time is included.</p></section><section class="field-section"><span class="field-label">Hard limits</span>${range('Estimated budget','maxFareCents',0,3000,100)}${range('Walking, total','maxWalkingMinutes',0,90,5,' min')}${range('Biking, total','maxBikingMinutes',0,90,5,' min')}${range('Transit transfers','maxTransfers',0,5,1)}</section><section class="field-section"><label class="toggle-row"><span>Use my own mix</span><input type="checkbox" name="custom" ${p.priority==='custom'?'checked':''}></label><div id="custom-weights" ${p.priority==='custom'?'':'hidden'}>${range('Save time','timeWeight',0,100,5)}${range('Save money','costWeight',0,100,5)}${range('Less time outside','outsideWeight',0,100,5)}${range('Less underground','undergroundWeight',0,100,5)}</div><p class="hint">Higher values give that priority more influence. Outdoor time and fares are estimates; your limits apply to those estimates.</p></section></form>`,`<button class="text-button" data-action="reset-preferences">Reset</button><button class="primary" data-action="apply-preferences">Find my connections ${icon('arrow')}</button>`);bikeFields();
}
function bikeFields(){const f=$('#preferences-form');if(!f)return;const own=f.elements.bikeSource.value==='ownBike';$('#membership-row').hidden=own;f.elements['mode-bus'].disabled=own;$('#bike-policy').textContent=own?'Your bike stays with you on walks and subway rides. Buses are excluded. Carrying it on station stairs adds effort.':'Classic bikes. Current pickup bikes and return docks are checked.';}
function applyPreferences(){const f=$('#preferences-form'),d=new FormData(f),p={...state.preferences};for(const k of ['maxFareCents','maxWalkingMinutes','maxBikingMinutes','maxTransfers','timeWeight','costWeight','outsideWeight','undergroundWeight'])p[k]=Number(d.get(k));p.bikeSource=d.get('bikeSource');p.walkingPace=d.get('walkingPace');p.citiBikeMember=f.elements.citiBikeMember.checked;p.requireLiveTransit=f.elements.requireLiveTransit.checked;p.modes=['walk',...['bike','subway','bus'].filter(m=>f.elements['mode-'+m].checked)];p.priority=d.has('custom')?'custom':p.priority==='custom'?'fastest':p.priority;state.preferences=p;sheet.close();state.modal=null;planTrip();}
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

function journeyLeg(r,leg,index){
 const ride=leg.mode==='subway'||leg.mode==='bus';
 const predictions=ride?`<p class="${leg.realtime?'live-note':''}">${leg.realtime?'Live prediction':'Scheduled'} · ${clock(leg.departureTime)} to ${clock(leg.arrivalTime)}</p><p>Board at ${esc(leg.from.name)} · ${mins(leg.waitingMinutes)} min wait${leg.predictionReportedAt?` · MTA report ${clock(leg.predictionReportedAt)}`:''}</p>`:'';
 const docks=leg.bikePickup?`<p class="live-note">${leg.bikePickup.classicBikes} classic bikes · ${leg.bikeReturn.docks} return docks when checked</p>`:'';
 const setup=leg.setupMinutes>0?`<p>About ${mins(Math.max(0,leg.duration-leg.setupMinutes))} min riding + ${mins(leg.setupMinutes)} min for pickup and return.</p>`:'';
 const steps=(leg.steps||[]).filter(step=>step.distance>5);
 const directions=steps.length?`<details><summary>Street directions</summary><ol>${steps.map(step=>{
  const turn=step.relativeDirection==='DEPART'?step.absoluteDirection:step.relativeDirection;
  return `<li>${esc(turn).replaceAll('_',' ').toLowerCase()} onto ${esc(step.streetName)} · ${Math.round(step.distance)} m${step.walkingBike?' · walk bike':''}</li>`;
 }).join('')}</ol></details>`:'';
 return `<div class="timeline-leg"><div class="timeline-icon">${icon(leg.mode)}</div><div class="timeline-content"><div><strong>${esc(leg.instruction)}</strong><small>${mins(leg.duration)} min</small></div>${predictions}${leg.mode==='subway'?trainChoices(r,index):''}${docks}${setup}<p>${esc(leg.to.name)}</p>${directions}</div></div>`;
}

function detail(route,{focus=false,expand=false}={}){
 if(!route)return;
 const scroll=$('.journey-outline',preview)?.scrollTop||0;
 state.journey??={};
 state.journey.route=route;
 journeyView('preview');
 const toolbar=[['refresh-detail','Refresh this trip','refresh'],['save','Save this trip','bookmark'],['share','Share this route','share'],['journey-size','Resize journey outline','chevron']];
 preview.innerHTML=`<header class="journey-header"><button class="journey-button" data-action="journey-back" aria-label="Back to routes">${icon('back')} Routes</button><div class="journey-actions">${toolbar.map(([action,label,symbol])=>`<button class="journey-button ${action==='journey-size'?'journey-resize':''}" data-action="${action}" aria-label="${label}">${icon(symbol)}</button>`).join('')}</div></header>
  <div class="journey-summary"><div><h2 id="journey-title" tabindex="-1">${mins(route.minutes)} min <time datetime="${esc(route.arrivalTime)}">Arrive ${clock(route.arrivalTime)}</time></h2><p>${esc(routeTitle(route))} · ${money(route.fareCents)} est. · ${mins(route.outdoorMinutes)} min outside</p></div><button class="primary" data-action="navigate" aria-label="Start navigation">${icon('navigate')} Start</button></div>
  <div class="journey-outline" tabindex="0" aria-label="Journey outline"><h3>Journey outline</h3><div class="timeline">${route.legs.map((leg,index)=>journeyLeg(route,leg,index)).join('')}</div><p class="hint">${route.legs.some(leg=>leg.bikePickup)?`${esc(route.fareAssumption)}. `:''}Checked ${clock(route.generatedAt)}.</p></div>`;
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
function savedTrips(){state.modal={type:'saved'};openSheet('Saved trips',`<p class="dialog-copy">Saved trips always search again with current data.</p>${state.saved.length?state.saved.map((s,i)=>`<div style="display:flex;align-items:center"><button class="saved-trip" data-saved="${i}">${icon('bookmark')}<span><strong>${esc(s.origin.name)} → ${esc(s.destination.name)}</strong><small>${labels[s.preferences.priority]} · ${s.preferences.bikeSource==='ownBike'?'My bike':'Citi Bike'}</small></span></button><button class="icon-button" data-remove-saved="${i}" aria-label="Remove saved trip">${icon('close')}</button></div>`).join(''):`<div class="empty">${icon('bookmark')}<h3>Keep a good connection.</h3><p>Open a route and tap the bookmark.</p></div>`}`);}
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

async function bikes(){if(!state.origin){choosePlace('origin');return;}state.modal={type:'bikes'};openSheet('Nearby Citi Bikes','<div class="loading"><i></i><span>Checking station reports…</span></div>');try{const s=await api(`/bikes?lat=${state.origin.coordinate.latitude}&lon=${state.origin.coordinate.longitude}`);if(state.modal?.type!=='bikes')return;openSheet('Nearby Citi Bikes',`<p class="dialog-copy">Near ${esc(state.origin.name)} · report ${clock(s.sourceTimestamp)}<br>Counts can change before you arrive.</p>${s.stale?'<div class="notice">Reports are stale. Refresh before relying on the counts.</div>':''}${s.stations.map(b=>`<article class="bike-station"><div><h4>${esc(b.name)}</h4><small>${Math.round(b.metersAway)} m</small></div><div class="station-counts"><span>${icon('bike')}${b.isRenting?(b.classicBikes??'?')+' classic':'Pickup paused'}</span><span>${icon('dock')}${b.isReturning?b.docks+' docks':'Returns paused'}</span></div>${Date.now()-b.reportedAt>300000?'<p class="hint amber">Station report is stale.</p>':''}<a href="https://maps.apple.com/?ll=${Number(b.coordinate.latitude)},${Number(b.coordinate.longitude)}&q=${encodeURIComponent(b.name)}" target="_blank" rel="noopener">View station in Maps ↗</a></article>`).join('')}`);}catch(e){openSheet('Nearby Citi Bikes',`<div class="empty"><h3>Reports unavailable.</h3><p>${esc(e.message)}</p><button class="primary" data-action="bikes">Try again</button></div>`);}}
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
 if(phase==='pickup')return {icon:'bike',title:`Pick up a Citi Bike at ${leg.bikePickup.name}`,context:'Unlock a bike at the dock.',confirm:'I have the bike',replan:false};
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
const countdown=time=>{const seconds=(Date.parse(time)-Date.now())/1000;return seconds< -30?'Departed':seconds<60?'Due':Math.ceil(seconds/60)+' min';};
async function transit({quiet=false}={}){
 if(!state.origin){choosePlace('origin');return;}
 state.modal={type:'transit'};
 if(!quiet)openSheet('Live trains and buses','<div class="loading"><i></i><span>Checking MTA predictions…</span></div>');
 try{
  const board=await api(`/transit?lat=${state.origin.coordinate.latitude}&lon=${state.origin.coordinate.longitude}`);if(state.modal?.type!=='transit')return;
  const section=mode=>{
   const rows=board.departures.filter(d=>d.mode===mode).slice(0,24),bus=mode==='bus',fresh=bus?!board.feedStatus.bus.stale:board.feedStatus.subway.some(f=>!f.stale);
   return `<section class="transit-section"><h3>${bus?'Buses':'Trains'}</h3>${bus&&!board.feedStatus.bus.configured?'<p class="dialog-copy">Live buses are not connected. Add the key from MTA’s email in the private setup field.</p><button class="primary" data-action="bus-setup">Connect Bus Time</button>':rows.length?rows.map(d=>`<article class="transit-departure"><span class="line-badge ${bus?'bus':''}" style="background:#${/^[0-9a-f]{6}$/i.test(d.routeColor)?d.routeColor:bus?'3678c7':'239a68'}">${esc(d.line)}</span><div><strong>${esc(d.stop.name)}</strong><p>${esc(d.direction||'')}${d.direction?' · ':''}${Math.round(d.metersAway)} m from start</p><small data-report-at="${esc(d.predictionReportedAt)}">MTA report ${Math.max(0,Math.floor((Date.now()-Date.parse(d.predictionReportedAt))/1000))}s ago</small></div><div class="transit-countdown"><b data-countdown="${esc(d.departureTime)}">${countdown(d.departureTime)}</b><small>${clock(d.departureTime)}</small></div></article>`).join(''):`<p class="dialog-copy">${fresh?'No upcoming departures reported at nearby stops.':'Current MTA predictions are unavailable. Check Sources or refresh.'}</p>`}</section>`;
  };
  const scroll=$('.dialog-body')?.scrollTop||0;
  openSheet('Live trains and buses',`<p class="dialog-copy">Within 1.2 km of ${esc(state.origin.name)}. Allow time to reach the stop. Refreshes every 30 seconds. Checked ${clock(board.generatedAt)}.</p>${section('subway')}${section('bus')}`,`<button class="text-button" data-action="sources">Sources</button><button class="primary" data-action="transit">Refresh predictions</button>`);
  if(quiet)$('.dialog-body').scrollTop=scroll;
 }catch(e){if(state.modal?.type==='transit')openSheet('Live trains and buses',`<div class="empty"><h3>Predictions unavailable</h3><p>${esc(e.message)}</p><button class="primary" data-action="transit">Try again</button></div>`);}
}
document.addEventListener('submit',event=>{if(event.target.id==='timing-form'){event.preventDefault();applyDeparture();}});
document.addEventListener('change',event=>{
 if(event.target.name!=='timeMode')return;
 const form=$('#timing-form'),custom=event.target.value!=='now';$('#custom-time').hidden=!custom;form.elements.time.disabled=!custom;
 if(custom)form.elements.includeSchedules.checked=true;
});

document.addEventListener('click',event=>{
 const b=event.target.closest('button,a.brand');if(!b)return;
 if(b.dataset.departureChoice){const option=state.response?.alternativeRoutes?.[b.dataset.departureChoice];if(!option||!canChooseDeparture(option)){toast('Refresh for current, reachable departures.');return;}departureSelections[option.groupId]=option.choiceId;const selected={...option,id:option.groupId};renderRoutes();detail(selected);toast('Departure selected. Arrival and transfers updated.');return;}
 if(b.dataset.action==='transit'){transit();return;}
 if(b.dataset.action==='refresh-detail'){refreshDetail();return;}
 if(b.matches('.brand')){event.preventDefault();map?.invalidateSize();drawRoute();return;}
 if(b.dataset.travelMode){state.travelMode=b.dataset.travelMode;state.selected=0;renderRoutes();mobileLayout.showRoutes();drawRoute();return;}
 if(b.dataset.priority){state.preferences.priority=b.dataset.priority;planTrip();return;}
 if(b.dataset.place){choosePlace(b.dataset.place);return;}
 if(b.dataset.selectPlace!=null){const p=state.places[Number(b.dataset.selectPlace)],key=state.modal.endpoint,other=key==='origin'?'destination':'origin';if(key==='origin'){currentLocation.cancel();state.location={status:'idle'};}if(state[other]?.id===p.id)[state.origin,state.destination]=[state.destination,state.origin];else state[key]=p;sheet.close();state.modal=null;planTrip();return;}
 if(b.dataset.route!=null){state.selected=Number(b.dataset.route);renderRoutes();detail(currentRoutes()[state.selected],{focus:true,expand:true});return;}
 if(b.dataset.saved!=null){currentLocation.cancel();state.location={status:'idle'};const s=state.saved[Number(b.dataset.saved)];state.origin=s.origin;state.destination=s.destination;state.preferences={...defaults(),...s.preferences};state.timing={mode:'now',time:null};sheet.close();state.modal=null;if(state.origin.id===CURRENT_LOCATION_ID)useCurrentLocation();else planTrip();return;}
 if(b.dataset.removeSaved!=null){state.saved.splice(Number(b.dataset.removeSaved),1);try{localStorage.setItem('crosstown.saved.v2',JSON.stringify(state.saved));savedTrips();}catch{toast('Couldn’t update saved trips.');}return;}
 switch(b.dataset.action){
  case'journey-back':closeJourney();break;
  case'journey-size':mobileLayout.resizeJourney();break;
  case'navigate':startNavigation();break;
  case'nav-end':endNavigation();break;
  case'nav-follow':followNavigation();break;
  case'nav-confirm':state.journey?.navigator?.confirm();break;
  case'nav-replan':replanNavigation();break;
  case'close':sheet.close();state.modal=null;break;
  case'preferences':preferences();break;
  case'apply-preferences':applyPreferences();break;
  case'reset-preferences':preferences(defaults());break;
  case'current-location':useCurrentLocation();break;
  case'refresh':refreshTrip();break;
  case'swap':currentLocation.cancel();state.location={status:'idle'};[state.origin,state.destination]=[state.destination,state.origin];refreshTrip();break;
  case'fit':drawRoute();break;
  case'bikes':bikes();break;
  case'sources':sources();break;
  case'bus-setup':busSetup();break;
  case'saved':savedTrips();break;
  case'save':saveTrip();break;
  case'share':share();break;
  case'departure':departure();break;
 }
});
document.addEventListener('input',event=>{const x=event.target;if(x.id==='place-query'){clearTimeout(searchTimer);const v=x.value;searchTimer=setTimeout(()=>findPlaces(v),650);}if(x.type==='range'){const out=$(`[data-output="${x.name}"]`);if(out)out.textContent=x.name==='maxFareCents'?money(Number(x.value)):x.value+x.dataset.unit;}});
document.addEventListener('change',event=>{if(event.target.name==='bikeSource')bikeFields();if(event.target.name==='custom')$('#custom-weights').hidden=!event.target.checked;});
sheet.addEventListener('cancel',()=>{state.modal=null;placeSearchId++;});sheet.addEventListener('click',event=>{if(event.target!==sheet)return;const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom){sheet.close();state.modal=null;placeSearchId++;}});
hydrate();currentLocation.request();initMap();drawRoute(false);
try{const [d,health]=await Promise.all([api('/places'),api('/health')]);state.places=d.places;state.health=health;if(health.router.mode==='community')map.attributionControl.addAttribution('<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>');else state.destination??=d.places.find(p=>p.id==='ues')??d.places[1];renderRoutes();if(new URLSearchParams(location.search).get('setup')==='bus-time'&&state.health.localSetupAvailable)busSetup();await planTrip();}catch(e){state.loading=false;state.error=e.message;renderRoutes();}
setInterval(()=>{updateFreshness();if(document.hidden)return;if(state.modal?.type==='transit')transit({quiet:true});else if(state.health?.router?.ready&&state.health.router.mode!=='community'&&!sheet.open&&!state.journey&&!state.loading&&state.origin)refreshTrip({quiet:true});},30000);
setInterval(()=>{if(state.modal?.type!=='transit')return;for(const n of document.querySelectorAll('[data-countdown]'))n.textContent=countdown(n.dataset.countdown);for(const n of document.querySelectorAll('[data-report-at]'))n.textContent=`MTA report ${Math.max(0,Math.floor((Date.now()-Date.parse(n.dataset.reportAt))/1000))}s ago`;},1000);
window.addEventListener('resize',()=>{map?.invalidateSize();drawRoute(false);});
