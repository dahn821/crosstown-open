import {access} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const required = [
  'Backend/data/nyc-lookup.json',
  'Backend/data/restaurants.json',
  'Backend/community-server.mjs',
  'netlify/functions/api.mjs',
  'Web/dist/index.html',
  'Web/dist/app.mjs',
  'Web/dist/manifest.webmanifest',
];

await Promise.all(required.map(name => access(new URL(name, root))));
console.log('Crosstown web assets and public NYC data are ready.');
