import {approachingWithinMinute,sampleTrack} from './track-position.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function arrivalLabel({arrivalTime,departureTime},now=Date.now()){
  const arrival=Date.parse(arrivalTime??departureTime),departure=Date.parse(departureTime??arrivalTime);
  if(!Number.isFinite(arrival)||!Number.isFinite(departure))return 'Unavailable';
  if(departure<now)return 'Departed';
  const seconds=(arrival-now)/1000;
  return seconds<60?'Due':Math.ceil(seconds/60)+' min';
}

export function platformID(call){
  return (call.stopId||call.stop?.id||'').split(':').at(-1);
}

export function trainIsDue(vehicle,stopId,now=Date.now()){
  return vehicle?.mode==='subway'&&vehicle.positionReport?.accuracy==='next-stop'&&
    vehicle.positionReport.stopId===stopId&&vehicle.nextStop?.stopId===stopId&&vehicle.motion?.toStopId===stopId&&
    approachingWithinMinute(vehicle.motion,Date.parse(vehicle.positionReport.reportedAt),now);
}

export function subwayArrivalLabel(call,vehicle,now=Date.now()){
  const stopId=platformID(call);
  const matching=call.isNextStop!==false&&vehicle?.trackingId===call.trackingId&&
    vehicle?.nextStop?.stopId===stopId&&vehicle.positionReport?.stopId===stopId;
  if(matching&&trainIsDue(vehicle,stopId,now))return 'Due';
  if(matching&&vehicle.positionReport.accuracy==='reported-stop'&&recent(vehicle.positionReport.reportedAt,now,60000)){
    return 'At station';
  }
  const arrival=matching&&vehicle.motion?.toStopId===stopId?vehicle.motion.arrivesAt:Date.parse(call.arrivalTime??call.departureTime);
  if(Date.parse(call.departureTime)<now&&!matching)return 'Departed';
  return arrival>now?Math.ceil((arrival-now)/60000)+' min':'Updating';
}

export function liveTimeMarkup(call,vehicle){
  const subway=call.mode==='subway';
  const text=subway?subwayArrivalLabel(call,vehicle):arrivalLabel(call);
  const trip=subway?` data-subway-trip="${escape(call.trackingId)}" data-stop-id="${escape(platformID(call))}" data-next-stop="${call.isNextStop!==false}"`:'';
  return `<time datetime="${escape(call.arrivalTime??call.departureTime)}" data-arrival-time="${escape(call.arrivalTime??call.departureTime)}" data-departure-time="${escape(call.departureTime)}"${trip} data-due="${text==='Due'}">${text}</time>`;
}

export function updateLiveTimes(panel,findTrip){
  const now=Date.now();
  for(const time of panel.querySelectorAll('time[data-arrival-time]')){
    const fields=time.dataset;
    const text='subwayTrip' in fields?subwayArrivalLabel({
      ...fields,trackingId:fields.subwayTrip,isNextStop:fields.nextStop==='true'
    },findTrip?.(fields.subwayTrip),now):arrivalLabel(fields,now);
    if(time.textContent!==text)time.textContent=text;
    time.dataset.due=String(text==='Due');
  }
}

function recent(report,now,maxAge){
  const time=Date.parse(report);
  return time>=now-maxAge&&time<=now+120000;
}

export function vehicleSource(vehicle){
  switch(vehicle.accuracy){
    case 'gps': return 'MTA GPS report';
    case 'interpolated': return 'Estimated from live train reports';
    case 'prediction-stop': case 'arrival-only': return 'MTA arrival estimate';
    case 'reported-stop': return 'MTA station report';
    default: return 'MTA next-stop report';
  }
}

export function vehicleReports(snapshot,now=Date.now()){
  const reports=new Map();
  for(const vehicle of snapshot){
    const tracked=vehicle.trackingId||vehicle.id;
    if(vehicle.accuracy!=='prediction-stop'){
      if(recent(vehicle.reportedAt,now,90000))reports.set(tracked,vehicle);
      continue;
    }
    const position=vehicle.positionReport;
    if(recent(position?.reportedAt,now,90000)){
      reports.set(tracked,{...vehicle,...position,source:'MTA subway vehicle reports',
        status:position.accuracy==='reported-stop'?`Reported at ${position.stopName}`:`Heading toward ${position.stopName}`,
        bearing:null,directionLabel:null,nextStop:null});
    }
  }
  return [...reports.values()].map(vehicle=>{
    const sample=vehicle.motion&&sampleTrack(vehicle.motion,now);
    return sample?{...vehicle,coordinate:sample.coordinate,bearing:sample.bearing}:vehicle;
  });
}
