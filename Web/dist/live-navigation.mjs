import {createJourneyProgress} from './journey-navigation.mjs';

const ridePhase = phase => phase === 'board' || phase === 'ride';

export function createLiveNavigation({route,onUpdate,lookupRide}) {
  const progress = createJourneyProgress(route);
  let active = false, visible = false, watch, watchVersion = 0, timer, wakeLock;
  let locationMessage = '', ride, rideIndex = -1, rideRequest, checkedAt = 0;

  function notify() {
    if (active) onUpdate({...progress.snapshot(),locationMessage,ride});
  }

  function clearWatch() {
    watchVersion++;
    if (watch != null) navigator.geolocation.clearWatch(watch);
    watch = undefined;
  }

  function trackLocation() {
    clearWatch();
    if (!window.isSecureContext || !navigator.geolocation) {
      locationMessage = 'Open Crosstown over HTTPS to use live location.';
      notify();
      return;
    }
    const version = watchVersion;
    locationMessage = '';
    try {
      watch = navigator.geolocation.watchPosition(position=>{
        if (!visible || version !== watchVersion) return;
        const next = progress.update(position);
        locationMessage = next.fix ? '' : 'Waiting for a precise GPS fix.';
        if (next.phase === 'arrived') {
          clearWatch();
          releaseScreen();
        }
        tick();
      },error=>{
        if (!visible || version !== watchVersion) return;
        locationMessage = error.code === 1 ? 'Allow Precise Location for this site in your browser.' : 'Location signal is weak. Follow the map and street signs.';
        notify();
      },{enableHighAccuracy:true,maximumAge:3000,timeout:15000});
    } catch {
      locationMessage = 'Live location is temporarily unavailable.';
    }
    notify();
  }

  async function updateRide(snapshot) {
    if (snapshot.index !== rideIndex || !ridePhase(snapshot.phase)) {
      rideRequest?.abort();
      rideRequest = undefined;
      ride = undefined;
      rideIndex = snapshot.index;
      checkedAt = 0;
    }
    const {leg,phase} = snapshot;
    if (!ridePhase(phase) || !leg.realtime || !leg.tripId || !leg.boardStopId || !leg.alightStopId
      || rideRequest || Date.now()-checkedAt < 60000) return;
    checkedAt = Date.now();
    const request = new AbortController();
    rideRequest = request;
    try {
      const next = await lookupRide(leg,request.signal);
      if (!request.signal.aborted) ride = next;
    } catch {
      if (!request.signal.aborted) ride = {status:'unavailable'};
    } finally {
      if (rideRequest === request) {
        rideRequest = undefined;
        notify();
      }
    }
  }

  function tick() {
    if (!visible) return;
    void updateRide(progress.snapshot());
    notify();
  }

  async function keepScreenOn() {
    if (!navigator.wakeLock || wakeLock || progress.snapshot().phase === 'arrived') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (visible && active && progress.snapshot().phase !== 'arrived') wakeLock = lock;
      else await lock.release();
    } catch { /* Directions stay available when screen wake lock is unavailable. */ }
  }

  function releaseScreen() {
    if (wakeLock) void wakeLock.release().catch(()=>{});
    wakeLock = undefined;
  }

  function suspend() {
    visible = false;
    clearWatch();
    rideRequest?.abort();
    rideRequest = undefined;
    clearInterval(timer);
    releaseScreen();
  }

  function resume() {
    if (!active || document.hidden || visible) return;
    visible = true;
    if (progress.snapshot().phase !== 'arrived') trackLocation();
    void keepScreenOn();
    timer = setInterval(tick,1000);
    tick();
  }

  function visibilityChanged() {
    if (document.hidden) suspend();
    else resume();
  }

  return {
    start() {
      if (active) return;
      active = true;
      document.addEventListener('visibilitychange',visibilityChanged);
      window.addEventListener('pagehide',suspend);
      window.addEventListener('pageshow',resume);
      resume();
    },
    snapshot:progress.snapshot,
    retryLocation() { if (visible && progress.snapshot().phase !== 'arrived') trackLocation(); },
    confirm() {
      const next = progress.confirm();
      if (next.phase === 'arrived') {
        clearWatch();
        releaseScreen();
      }
      tick();
    },
    stop() {
      active = false;
      suspend();
      document.removeEventListener('visibilitychange',visibilityChanged);
      window.removeEventListener('pagehide',suspend);
      window.removeEventListener('pageshow',resume);
    },
  };
}
