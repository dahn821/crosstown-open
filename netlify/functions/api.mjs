import fs from 'node:fs/promises';
import path from 'node:path';
import {getStore} from '@netlify/blobs';
import {createCommunityAPI} from '../../Backend/community-server.mjs';
import {communityBudget} from '../../Backend/community-budget.mjs';

let ready;

async function initialize(){
  const read=async name=>JSON.parse(await fs.readFile(path.join(process.cwd(),'Backend/data',name),'utf8'));
  const [lookup,restaurants]=await Promise.all([read('nyc-lookup.json'),read('restaurants.json')]);
  const storage=getStore({name:'crosstown-routing-usage',consistency:'strong'});
  const beforeRequest=communityBudget(storage,{local:process.env.NETLIFY_DEV==='true'});
  return createCommunityAPI({lookup,restaurants,busKey:process.env.MTA_BUS_TIME_KEY||'',beforeRequest});
}

export default async function handler(request){
  ready??=initialize().catch(error=>{ready=null;throw error;});
  return (await ready)(request);
}
export const config={path:'/api/*'};
