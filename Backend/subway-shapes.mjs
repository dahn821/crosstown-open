import fs from 'node:fs';

function readShapes(){
  try{return JSON.parse(fs.readFileSync(new URL('./data/shapes.json',import.meta.url),'utf8'));}catch{return {};}
}

export const subwayShapes=readShapes();
const meters=(a,b)=>Math.hypot((a[0]-b[0])*111200,(a[1]-b[1])*84200);
const position=stop=>[stop.latitude,stop.longitude];
const baseLine=line=>String(line||'').replace(/^([567F])X$/,'$1');
const rounded=point=>point.map(value=>Math.round(value*1e5)/1e5);
const maxSnapMeters=85;

function projection(point,a,b){
  const dx=(b[0]-a[0])*111200,dy=(b[1]-a[1])*84200;
  const px=(point[0]-a[0])*111200,py=(point[1]-a[1])*84200,length=dx*dx+dy*dy;
  const t=length?Math.min(1,Math.max(0,(px*dx+py*dy)/length)):0;
  return {t,error:(px-t*dx)**2+(py-t*dy)**2};
}

// A few meters of simplification keeps a citywide view light while preserving curves.
function simplify(points,start=0,end=points.length-1,result=[points[start]]){
  let furthest=start,error=9;
  for(let i=start+1;i<end;i++){
    const candidate=projection(points[i],points[start],points[end]).error;
    if(candidate>error){furthest=i;error=candidate;}
  }
  if(furthest>start){
    simplify(points,start,furthest,result);
    simplify(points,furthest,end,result);
  }else result.push(points[end]);
  return result;
}

export function createSubwayGeometry(stops={},shapes=subwayShapes){
  const prepared=new Map(),byLine=new Map(),resolved=new Map();
  const entries=Object.entries(shapes).filter(([,points])=>points.length>=2);
  for(const entry of entries){
    const line=baseLine(entry[0].split('.')[0]);
    if(!byLine.has(line))byLine.set(line,[]);
    byLine.get(line).push(entry);
  }
  function shapeFor([id,points]){
    if(prepared.has(id))return prepared.get(id);
    const bbox=[Infinity,Infinity,-Infinity,-Infinity],lengths=[0];
    for(const [index,point] of points.entries()){
      bbox[0]=Math.min(bbox[0],point[0]);bbox[1]=Math.min(bbox[1],point[1]);
      bbox[2]=Math.max(bbox[2],point[0]);bbox[3]=Math.max(bbox[3],point[1]);
      if(index)lengths.push(lengths[index-1]+meters(points[index-1],point));
    }
    const shape={points,bbox,lengths,snaps:new Map()};
    prepared.set(id,shape);
    return shape;
  }
  function snap(shape,id){
    const stop=stops[id];if(!stop)return null;
    const point=position(stop),key=point.join(',');
    if(shape.snaps.has(key))return shape.snaps.get(key);
    const [lat,lon]=point,[south,west,north,east]=shape.bbox;
    if(lat<south-.0008||lat>north+.0008||lon<west-.0011||lon>east+.0011)return null;
    let best=null,bestError=maxSnapMeters**2;
    for(let index=0;index<shape.points.length-1;index++){
      const a=shape.points[index],b=shape.points[index+1],p=projection(point,a,b);
      if(p.error>=bestError)continue;
      bestError=p.error;
      best={index,along:shape.lengths[index]+p.t*(shape.lengths[index+1]-shape.lengths[index]),
        coordinate:[a[0]+p.t*(b[0]-a[0]),a[1]+p.t*(b[1]-a[1])],error:Math.sqrt(p.error)};
    }
    shape.snaps.set(key,best);
    return best;
  }
  function match(entry,from,to,previous,next,direct,shared){
    const shape=shapeFor(entry),a=snap(shape,from),b=snap(shape,to);
    if(!a||!b||Math.max(a.error,b.error)>(shared?50:maxSnapMeters))return null;
    const span=Math.abs(b.along-a.along),forward=b.along>a.along;
    if(span<5||span>Math.max(direct+260,direct*2.1))return null;
    const start=forward?a:b,end=forward?b:a,sign=forward?1:-1;
    const before=snap(shape,previous),after=snap(shape,next);
    const aligned=(before&&(a.along-before.along)*sign>5?1:0)+(after&&(after.along-b.along)*sign>5?1:0);
    const score=a.error+b.error+(span-direct)*.04+(forward?0:2)-aligned*12;
    return {shape,start,end,forward,score};
  }
  function find(line,tripId,from,to,{previous,next,shapeId}={}){
    if(!stops[from]||!stops[to])return null;
    const key=[line,tripId?.split('_').at(-1),shapeId,from,to,previous,next].join('|');
    if(resolved.has(key))return resolved.get(key);
    const direct=meters(position(stops[from]),position(stops[to]));
    const suffix=tripId?.split('_').at(-1),canonical=suffix?.replace(/X\d+$/,'R');
    let best=null;
    for(const id of new Set([shapeId,suffix,canonical])){
      if(!shapes[id]||shapes[id].length<2)continue;
      best=match([id,shapes[id]],from,to,previous,next,direct,false);
      if(best)break;
    }
    if(!best){
      const route=baseLine(line);
      for(const candidates of [byLine.get(route)||[],entries]){
        const shared=candidates===entries;
        for(const entry of candidates){
          const candidate=match(entry,from,to,previous,next,direct,shared);
          if(candidate&&(!best||candidate.score<best.score))best=candidate;
        }
        if(best)break;
      }
    }
    let points=null;
    if(best){
      const {shape,start,end,forward}=best;
      const path=simplify([start.coordinate,...shape.points.slice(start.index+1,end.index+1),end.coordinate]).map(rounded);
      points=forward?path:path.reverse();
    }
    if(resolved.size>=12000)resolved.delete(resolved.keys().next().value);
    resolved.set(key,points);
    return points;
  }
  return find;
}

export function subwayJourneyPoints(store,{line,tripId,stopIds},{requireShape=false}={}){
  const points=[];
  for(const [index,from] of stopIds.entries()){
    const to=stopIds[index+1];
    if(!to)break;
    const path=store.subwayGeometry?.(line,tripId,from,to,{previous:stopIds[index-1],next:stopIds[index+2]});
    if(!path&&requireShape)return null;
    const fallback=[from,to].map(id=>store.tripIndex?.stops?.[id]).filter(Boolean).map(position);
    points.push(...(path||fallback));
  }
  return points.map(([latitude,longitude])=>({latitude,longitude}));
}
