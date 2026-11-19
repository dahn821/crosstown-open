const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function arrivalLabel({arrivalTime,departureTime},now=Date.now()){
  const arrival=Date.parse(arrivalTime??departureTime),departure=Date.parse(departureTime??arrivalTime);
  if(!Number.isFinite(arrival)||!Number.isFinite(departure))return 'Unavailable';
  if(departure<now)return 'Departed';
  const seconds=(arrival-now)/1000;
  return seconds<60?'Due':Math.ceil(seconds/60)+' min';
}

export function liveTimeMarkup(call){
  const text=arrivalLabel(call);
  return `<time datetime="${escape(call.arrivalTime??call.departureTime)}" data-arrival-time="${escape(call.arrivalTime??call.departureTime)}" data-departure-time="${escape(call.departureTime)}" data-due="${text==='Due'}">${text}</time>`;
}

export function updateLiveTimes(panel){
  const now=Date.now();
  for(const time of panel.querySelectorAll('time[data-arrival-time]')){
    const text=arrivalLabel(time.dataset,now);
    if(time.textContent!==text)time.textContent=text;
    time.dataset.due=String(text==='Due');
  }
}

function recent(report,now,maxAge){
  const time=Date.parse(report);
  return time>=now-maxAge&&time<=now+120000;
}

export function trainIsDue(vehicle,now=Date.now()){
  const stop=vehicle.nextStop;
  return Boolean(stop&&recent(stop.reportedAt,now,180000)&&arrivalLabel(stop,now)==='Due');
}

export function vehicleSource(vehicle){
  switch(vehicle.accuracy){
    case 'gps': return 'MTA GPS report';
    case 'prediction-stop': case 'arrival-only': return 'MTA arrival estimate';
    case 'reported-stop': return 'MTA station report';
    default: return 'MTA next-stop report';
  }
}

export function vehicleReports(snapshot,board,now=Date.now()){
  const reports=new Map();
  for(const vehicle of snapshot){
    const tracked=vehicle.trackingId||vehicle.id;
    if(vehicle.accuracy!=='prediction-stop'||trainIsDue(vehicle,now)){
      if(recent(vehicle.reportedAt,now,vehicle.accuracy==='prediction-stop'?180000:90000))reports.set(tracked,vehicle);
      continue;
    }
    const position=vehicle.positionReport;
    if(recent(position?.reportedAt,now,90000)){
      reports.set(tracked,{...vehicle,...position,source:'MTA subway vehicle reports',
        status:position.accuracy==='reported-stop'?`Reported at ${position.stopName}`:`Heading toward ${position.stopName}`,
        bearing:null,directionLabel:null,nextStop:null});
    }
  }
  for(const row of board){
    if(row.mode!=='subway'||!row.trackingId||!row.stop?.coordinate||
      !recent(row.predictionReportedAt,now,180000)||arrivalLabel(row,now)!=='Due')continue;
    const vehicle=reports.get(row.trackingId);
    if(vehicle?.accuracy==='gps')continue;
    const stopId=row.stop.id.split(':').at(-1),name=row.stop.name;
    const nextStop={stopId,name,coordinate:row.stop.coordinate,arrivalTime:row.arrivalTime,
      departureTime:row.departureTime,reportedAt:row.predictionReportedAt};
    if(vehicle?.accuracy==='reported-stop'&&vehicle.positionReport?.stopId===stopId){
      reports.set(row.trackingId,{...vehicle,nextStop,directionLabel:row.direction||vehicle.directionLabel});
      continue;
    }
    const sameStop=vehicle?.accuracy==='prediction-stop'&&vehicle.nextStop?.stopId===stopId;
    reports.set(row.trackingId,{...vehicle,id:vehicle?.id||row.trackingId,trackingId:row.trackingId,
      mode:'subway',line:row.line,routeColor:row.routeColor,coordinate:nextStop.coordinate,
      accuracy:'prediction-stop',status:`Due at ${name}`,stopName:name,nextStop,
      directionLabel:row.direction||vehicle?.directionLabel,bearing:sameStop?vehicle.bearing:null,
      source:'MTA subway arrival predictions',reportedAt:row.predictionReportedAt});
  }
  return [...reports.values()];
}
