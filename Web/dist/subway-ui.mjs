const palette=[
  ['EE352E','1 2 3'],['00933C','4 5 6'],['B933AD','7'],['0039A6','A C E SI SIR'],
  ['FF6319','B D F M'],['6CBE45','G'],['996633','J Z'],['A7A9AC','L'],
  ['FCCC0A','N Q R W'],['808183','S FS GS H']
];
const colors=new Map(palette.flatMap(([color,lines])=>lines.split(' ').map(line=>[line,color])));
const shuttles={FS:'Franklin Avenue Shuttle',GS:'42 Street Shuttle',H:'Rockaway Park Shuttle'};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function subwayStyle(line,reportedColor){
  const express=/^[67F]X$/.test(line),service=express?line.slice(0,-1):line;
  const label=Object.hasOwn(shuttles,service)?'S':service;
  const color=/^[0-9a-f]{6}$/i.test(reportedColor)?reportedColor:colors.get(service)||'4A6371';
  const [r,g,b]=color.match(/../g).map(pair=>{
    const v=Number.parseInt(pair,16)/255;
    return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  });
  const ink=.2126*r+.7152*g+.0722*b>.18?'#000':'#fff';
  return {label,color:'#'+color,ink,express,name:shuttles[service]||(express?`${label} express`:label)};
}
export function subwayBullet(line,color){
  const style=subwayStyle(line,color);
  return `<span class="subway-bullet ${style.express?'express':''}" style="--rail-color:${style.color};--rail-ink:${style.ink}" aria-label="${escape(style.name)}"><span aria-hidden="true">${escape(style.label)}</span></span>`;
}
