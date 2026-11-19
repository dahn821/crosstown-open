const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function nyLocalInput(value=new Date()){
  const p=Object.fromEntries(formatter.formatToParts(new Date(value)).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function nyTimeToISO(value){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return null;
  const [year,month,day,hour,minute]=value.split(/[-T:]/).map(Number),wall=Date.UTC(year,month-1,day,hour,minute);
  let instant=wall;
  for(let i=0;i<3;i++){
    const parts=nyLocalInput(instant).split(/[-T:]/).map(Number);
    instant+=wall-Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4]);
  }
  return nyLocalInput(instant)===value?new Date(instant).toISOString():null;
}
export function timingPayload(timing){
  return timing.mode==='departAt'?{departureTime:timing.time}:timing.mode==='arriveBy'?{arrivalTime:timing.time}:{};
}
export function timingLabel(timing){
  if(timing.mode==='now')return 'Leave now';
  const date=new Date(timing.time),label=date.toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
  return `${timing.mode==='arriveBy'?'Arrive by':'Depart at'} ${label}`;
}
