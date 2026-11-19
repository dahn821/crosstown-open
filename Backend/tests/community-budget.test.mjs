import assert from 'node:assert/strict';
import test from 'node:test';
import {communityBudget} from '../community-budget.mjs';

test('the shared limit survives concurrent workers and releases expired slots', async()=>{
  let record, version=0, now=100;
  const storage={
    async getWithMetadata(){return record;},
    async setJSON(_key,data,{onlyIfMatch,onlyIfNew}){
      if(onlyIfNew?record!=null:record?.etag!==onlyIfMatch)return {modified:false};
      record={data,etag:String(++version)};
      return {modified:true};
    },
  };
  const worker=()=>communityBudget(storage,{limit:2,windowMs:20,now:()=>now});
  const first=worker(),second=worker();
  const results=await Promise.allSettled([first(),second(),first()]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,2);
  assert.equal(results.find(result=>result.status==='rejected').reason.status,429);
  assert.deepEqual(record.data,{times:[100,100]});
  now=121;
  await second();
  assert.deepEqual(record.data,{times:[121]});
});

test('a storage failure cannot proceed to an upstream request',async()=>{
  const consume=communityBudget({async getWithMetadata(){throw Error('Storage unavailable');}});
  await assert.rejects(consume,/Storage unavailable/);
});
