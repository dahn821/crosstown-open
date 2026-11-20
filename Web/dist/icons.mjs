const paths={
  arrow:'M5 19 19 5M5 5h14v14',chevron:'m9 5 7 7-7 7',close:'m6 6 12 12M6 18 18 6',
  back:'M19 12H5m6-6-6 6 6 6',navigate:'m3 11 18-8-8 18-2-8-8-2Z',
  turnLeft:'M17 21v-8a5 5 0 0 0-5-5H5m5-5L5 8l5 5',turnRight:'M7 21v-8a5 5 0 0 1 5-5h7m-5-5 5 5-5 5',
  explore:'m12 3 9 9-9 9-9-9 9-9ZM9 16v-5h7m-3-3 3 3-3 3',
  walk:'M14 5a1.5 1.5 0 1 0 0-.01M10 21l3-7-4-3 2-4 4 5h4M5 14l4-3M17 21l-4-7',
  bike:'M7 17a4 4 0 1 0 0 .01M19 17a4 4 0 1 0 0 .01M7 17l4-9 8 9M7 17h7L9 6H6m9 0h4',
  subway:'M7 3h10a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM4 12h16M8 16h.1M16 16h.1M8 20l-2 2m10-2 2 2M12 3v9',
  bus:'M7 3h10a3 3 0 0 1 3 3v13H4V6a3 3 0 0 1 3-3ZM4 12h16M8 16h.1M16 16h.1M7 19v3m10-3v3M2 8v4m20-4v4',
  bookmark:'M6 3h12v19l-6-4-6 4V3Z',bolt:'m13 2-9 12h7l-1 8 10-12h-7l1-8Z',
  sun:'M12 8a4 4 0 1 0 .01 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  umbrella:'M2 12a10 10 0 0 1 20 0H2Zm10 0v7a2 2 0 0 0 4 0M12 2V1',
  dollar:'M12 2v20m5-15c-1-4-10-4-10 1s10 3 10 8-9 5-11 1',
  sliders:'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6',
  sparkle:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  swap:'M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4',
  pin:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0ZM12 7a3 3 0 1 0 .01 0',
  start:'M12 3a9 9 0 1 0 .01 0M12 8a4 4 0 1 0 .01 0',
  weather:'M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9 2 3 3 0 1 1 1 6H7ZM14 2v2m6 1-2 2m4 3h-2M4 20h13',
  refresh:'M20 10a8 8 0 1 0-2 8M20 3v7h-7',check:'m5 12 4 4L20 5',share:'M12 16V2m-4 4 4-4 4 4M5 10H3v12h18V10h-2',dock:'M5 21V3h8a5 5 0 0 1 0 10H5',
  scan:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9Z',
};
Object.assign(paths,{search:'M10 3a7 7 0 1 0 .01 0M15 15l6 6',clock:'M12 3a9 9 0 1 0 .01 0M12 7v5l3 2',activity:'M2 12h5l3-8 4 16 3-8h5',locate:'M12 8a4 4 0 1 0 .01 0M12 2v3m0 14v3M2 12h3m14 0h3'});
export const icon=(name)=>`<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name]||paths.arrow}"/></svg>`;
