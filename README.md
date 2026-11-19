# Crosstown

Crosstown combines New York City subway, bus, walking, and biking directions. The web app runs in Safari on iPhone. The SwiftUI client can use the same HTTPS server.

## Run or deploy

1. Install Node.js 24 and run `npm ci` then `npm run dev`.
2. For hosting, create a Netlify project with this repository as the project root. The included `netlify.toml` builds the web app and its Node function. Netlify Blobs enforces a shared cap of 600 Transitous planning requests per rolling 24 hours.
3. Set `MTA_BUS_TIME_KEY` as a secret available to Functions if you have a developer key. It enables direct Bus Time predictions and bus GPS. Without it, enable scheduled transit to see bus route options.
4. For the native app, open `Crosstown.xcodeproj` in Xcode, select the Crosstown scheme, and configure your HTTPS address under **Sources & connection**.

Run `npm test` for backend and web tests and `swift test --package-path Core` for the native core tests.

## Routing and data

The hosted app sends trip coordinates, timing, and mode settings to [Transitous](https://transitous.org/sources/) for street routes and transit candidates. Crosstown checks reachable transit legs against current MTA stop predictions, checks Citi Bike pickup bikes and return docks, filters by the user's limits, and ranks the remaining options. It searches a bounded set of routes. Use Refresh to request a new plan. Live vehicle markers and nearby departures are fetched independently. Bus markers use reported GPS. Subway markers use reported stations or next stops.

**Best + Fastest** ranks by door-to-door time across enabled modes. The **Subway** and **Bus** tabs show trips that spend most of their riding time on that mode, summed across transfers. **Best + Less outside** compares bike-free subway and bus trips by estimated outdoor time, then by total travel time.

Select a route to highlight it on the map and open its journey outline. **Start navigation** gives on-screen walking and biking directions in the foreground, with prompts to confirm Citi Bike pickup and return and transit boarding and alighting. Crosstown checks the selected live transit trip while you wait or ride. The phone processes navigation fixes in memory. A new search uses your location only when you pick **Find a new route**.

The community deployment uses Transitous only for noncommercial, light use under its [API policy](https://transitous.org/api/). For other deployments or commercial use, arrange your own routing provider. Report issues through this repository.

Route requests can contain precise locations. Netlify handles the requests, and Transitous receives the route coordinates. Address searches can go to Photon. The Crosstown server does not write trip history to storage. Saved trips remain on the device. The shared request cap stores request timestamps. Consult [Netlify](https://www.netlify.com/privacy/) and [Transitous](https://transitous.org/privacy/) for their service privacy policies.

## License and attribution

The original Crosstown application code is licensed under [MIT](LICENSE). Third-party software and data retain their respective terms.

- Transitous uses [OpenStreetMap](https://www.openstreetmap.org/copyright) and other [listed data sources](https://transitous.org/sources/). OpenStreetMap data is © OpenStreetMap contributors, available under the ODbL. The map uses [OpenFreeMap](https://openfreemap.org/) and OpenMapTiles with an OpenStreetMap raster fallback.
- Transit schedules, bus and subway stops, station structures, and live reports come from [MTA developer feeds](https://www.mta.info/developers) and [New York State Open Data](https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f). Live dock and bike reports come from [Citi Bike GBFS](https://citibikenyc.com/system-data).
- Restaurant names, addresses, and locations come from [NYC restaurant inspection results](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j). The snapshot reflects active permits at extraction. Place search also uses [Photon](https://photon.komoot.io/) and OpenStreetMap.
- Original vendor licenses for Leaflet, MapLibre GL JS, and the MapLibre/Leaflet adapter are kept in `Web/dist/vendor/`. Apple MapKit provides the native basemap and its attribution.
