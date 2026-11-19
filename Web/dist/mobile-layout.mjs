// A draggable route sheet leaves the street map available while comparing trips.
export function attachMobileLayout({map,onFit}){
  const media=matchMedia('(max-width:700px)'),card=document.querySelector('#results-card');
  const grip=card.querySelector('.sheet-grip'),toggle=card.querySelector('[data-action="sheet-size"]');
  const mapToggle=document.querySelector('[data-action="map-view"]');
  let snap='peek',drag,ignoreClick=false;
  function points(){
    const style=getComputedStyle(card),safe=parseFloat(style.paddingBottom)||0;
    const bottom=parseFloat(style.bottom)||0;
    const navigation=card.dataset.content==='navigation';
    const preview=card.dataset.content==='preview';
    const top=preview?Math.max(78,innerHeight*.12):
      document.querySelector(navigation?'#navigation-prompt':'.search-card').getBoundingClientRect().bottom+12;
    const full=Math.max(200,innerHeight-top-bottom);
    const peek=navigation?152:preview?222:128;
    return {peek:peek+safe,half:Math.min(full,Math.max(280,innerHeight*(preview ? .49 : .43))),full};
  }
  function setSnap(value){
    snap=value;card.dataset.sheetState=value;card.classList.remove('collapsed');
    card.style.removeProperty('--drag-height');card.removeAttribute('data-dragging');
    const expanded=value!=='peek';
    grip.setAttribute('aria-expanded',String(expanded));
    grip.setAttribute('aria-label',expanded?'Collapse routes to see more map':'Show route options');
    toggle.setAttribute('aria-label',value==='full'?'Reduce route list':'Expand route list');
    mapToggle.setAttribute('aria-pressed',String(!expanded));
    mapToggle.querySelector('span').textContent=expanded?'Show map':'Show routes';
    mapToggle.setAttribute('aria-label',expanded?'Show more map':'Show route options');
    if(media.matches)card.style.setProperty('--sheet-height',points()[value]+'px');
    else card.style.removeProperty('--sheet-height');
  }
  grip.addEventListener('click',event=>{
    event.stopPropagation();if(ignoreClick){ignoreClick=false;return;}
    setSnap(snap==='peek'?'half':'peek');
  });
  toggle.addEventListener('click',()=>setSnap(snap==='full'?'half':'full'));
  mapToggle.addEventListener('click',()=>{setSnap(snap==='peek'?'half':'peek');if(snap==='peek')onFit();});
  grip.addEventListener('pointerdown',event=>{
    if(!media.matches)return;
    ignoreClick=false;drag={y:event.clientY,height:card.getBoundingClientRect().height,moved:false};
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove',event=>{
    if(!drag)return;const delta=drag.y-event.clientY;
    if(Math.abs(delta)>8)drag.moved=true;
    if(!drag.moved)return;
    const p=points();card.dataset.dragging='true';
    card.style.setProperty('--drag-height',Math.max(p.peek,Math.min(p.full,drag.height+delta))+'px');
  });
  function endDrag(event){
    if(!drag)return;
    const moved=drag.moved;
    if(drag.moved){
      const height=card.getBoundingClientRect().height,p=points();
      setSnap(Object.keys(p).sort((a,b)=>Math.abs(p[a]-height)-Math.abs(p[b]-height))[0]);
    }
    if(grip.hasPointerCapture(event.pointerId))grip.releasePointerCapture(event.pointerId);
    drag=null;ignoreClick=moved;
    // A swipe must not also activate the following synthetic click.
    if(moved)setTimeout(()=>ignoreClick=false,0);
  }
  grip.addEventListener('pointerup',endDrag);
  grip.addEventListener('pointercancel',()=>{drag=null;setSnap(snap);});
  map.on('dragstart',()=>{if(media.matches&&card.dataset.content!=='navigation')setSnap('peek');});
  new ResizeObserver(()=>{
    document.documentElement.style.setProperty('--results-height',card.getBoundingClientRect().height+'px');
  }).observe(card);
  const resize=()=>setSnap(snap);media.addEventListener('change',resize);window.addEventListener('resize',resize);
  setSnap('peek');
  return {showRoutes:()=>{if(media.matches)setSnap('half');},showMap:()=>{if(media.matches)setSnap('peek');},showNavigation:()=>{if(media.matches)setSnap('peek');},resizeJourney(){if(media.matches)setSnap(snap==='full'?'half':'full');},fitPadding(){
    if(!media.matches)return {paddingTopLeft:[430,95],paddingBottomRight:[65,85]};
    if(snap==='full')setSnap('peek');
    const top=card.dataset.content==='preview'?44:
      document.querySelector(card.dataset.content==='navigation'?'#navigation-prompt':'.search-card').getBoundingClientRect().bottom;
    const bottom=parseFloat(getComputedStyle(card).bottom)||0;
    return {paddingTopLeft:[24,top+20],paddingBottomRight:[65,points()[snap]+bottom+24]};
  }};
}
