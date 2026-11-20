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
  if(call.predictionReportedAt&&!recent(call.predictionReportedAt,now,90000))return null;
  const stopId=platformID(call);
  const sameTrain=call.trackingId&&vehicle?.trackingId===call.trackingId;
  const matching=call.isNextStop!==false&&sameTrain&&
    vehicle?.nextStop?.stopId===stopId&&vehicle.positionReport?.stopId===stopId;
  if(call.isNextStop!==false&&sameTrain&&!matching&&vehicle.nextStop?.stopId&&
    Date.parse(vehicle.reportedAt)>Date.parse(call.predictionReportedAt))return null;
  if(matching&&vehicle.positionReport.accuracy==='reported-stop'&&recent(vehicle.positionReport.reportedAt,now,60000)){
    return 'At station';
  }
  const departure=Date.parse((matching&&vehicle.nextStop.departureTime)||call.departureTime);
  if(departure<now)return null;
  if(matching&&trainIsDue(vehicle,stopId,now))return 'Due';
  const arrival=matching&&vehicle.motion?.toStopId===stopId&&vehicle.motion.expiresAt>=now?
    vehicle.motion.arrivesAt:Date.parse(call.arrivalTime??call.departureTime);
  return arrival>now?Math.max(1,Math.round((arrival-now)/60000))+' min':null;
}

export function liveTimeMarkup(call,vehicle){
  const subway=call.mode==='subway';
  const text=subway?subwayArrivalLabel(call,vehicle):arrivalLabel(call);
  const trip=subway?` data-subway-trip="${escape(call.trackingId)}" data-stop-id="${escape(platformID(call))}" data-next-stop="${call.isNextStop!==false}" data-prediction-reported-at="${escape(call.predictionReportedAt)}"`:'';
  return `<time datetime="${escape(call.arrivalTime??call.departureTime)}" data-arrival-time="${escape(call.arrivalTime??call.departureTime)}" data-departure-time="${escape(call.departureTime)}"${trip} data-due="${text==='Due'}">${text??'—'}</time>`;
}

export function updateLiveTimes(panel,findTrip){
  const now=Date.now();
  let expired=false;
  for(const time of panel.querySelectorAll('time[data-arrival-time]')){
    const fields=time.dataset;
    const text='subwayTrip' in fields?subwayArrivalLabel({
      ...fields,trackingId:fields.subwayTrip,isNextStop:fields.nextStop==='true'
    },findTrip?.(fields.subwayTrip),now):arrivalLabel(fields,now);
    const label=text??'—';
    if(time.textContent!==label){
      expired||=text==null;
      time.textContent=label;
    }
    time.dataset.due=String(text==='Due');
  }
  return expired;
}

function recent(report,now,maxAge){
  const time=Date.parse(report);
  return time>=now-maxAge&&time<=now+120000;
}

export function vehicleSource(vehicle){
  switch(vehicle.accuracy){
    case 'gps': return 'MTA GPS report';
    case 'interpolated': return 'Estimated from live train reports';
    case 'prediction-stop': case 'arrival-only': return 'Live arrival estimate';
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
    if(position?.accuracy==='reported-stop'&&recent(position.reportedAt,now,90000)){
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
