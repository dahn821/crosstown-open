import {createLocationSource} from './current-location.mjs';

// This small entry point runs independently of the map/vendor import graph.
export const deviceLocation=createLocationSource({geolocation:navigator.geolocation,secure:window.isSecureContext});
void deviceLocation.prefetch();

// Warm an authorized foreground session after returning to the app. Permission
// prompts remain part of the explicit current-location flow after a denial.
document.addEventListener('visibilitychange',async()=>{
 if(document.hidden||!navigator.permissions)return;
 try{if((await navigator.permissions.query({name:'geolocation'})).state==='granted'&&!document.hidden)void deviceLocation.prefetch();}catch{}
});
