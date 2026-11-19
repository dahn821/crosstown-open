export function sampleTrack({points,startedAt,arrivesAt,expiresAt},now){
  if(now>expiresAt||arrivesAt<=startedAt||points.length<2)return null;
  const part=Math.max(0,Math.min(1,(now-startedAt)/(arrivesAt-startedAt)));
  const distance=part*points.at(-1)[2];
  let i=1;
  while(i<points.length-1&&points[i][2]<distance)i++;
  const a=points[i-1],b=points[i];
  const along=b[2]>a[2]?(distance-a[2])/(b[2]-a[2]):0;
  const deltaLat=b[0]-a[0],deltaLon=b[1]-a[1];
  return {coordinate:{latitude:a[0]+deltaLat*along,longitude:a[1]+deltaLon*along},
    bearing:(Math.atan2(deltaLon*84200,deltaLat*111200)*180/Math.PI+360)%360,index:i};
}

export function remainingTrack(motion,now){
  const sample=motion&&sampleTrack(motion,now);
  if(!sample||now>=motion.arrivesAt)return null;
  const {latitude,longitude}=sample.coordinate;
  return [[latitude,longitude],...motion.points.slice(sample.index).map(([lat,lon])=>[lat,lon])];
}
