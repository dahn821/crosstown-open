import test from 'node:test';
import assert from 'node:assert/strict';
import {searchRoutes} from '../dist/route-search.mjs';

test('split stream chunks show the first route before the final comparison arrives',async t=>{
  const encoder=new TextEncoder(),seen=Promise.withResolvers();
  let stream;
  const body=new ReadableStream({start(controller){stream=controller;}});
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    assert.match(options.headers.Accept,/application\/x-ndjson/);
    return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
  });
  const route={minutes:3,legs:[{mode:'walk'}]},plan={routes:[route]};
  const pending=searchRoutes({},{onPreview:seen.resolve});
  const preview=JSON.stringify({type:'preview',route})+'\n';
  stream.enqueue(encoder.encode(preview.slice(0,13)));
  stream.enqueue(encoder.encode(preview.slice(13)));
  assert.deepEqual(await seen.promise,route);
  stream.enqueue(encoder.encode(JSON.stringify({type:'result',plan})+'\n'));
  stream.close();
  assert.deepEqual(await pending,plan);
});

test('route search still accepts a regular JSON plan from a local server',async t=>{
  const plan={routes:[]};
  t.mock.method(globalThis,'fetch',async()=>Response.json(plan));
  assert.deepEqual(await searchRoutes({},{onPreview:()=>assert.fail('Unexpected preview')}),plan);
});
