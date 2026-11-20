import SwiftUI
import MapKit
import CrosstownCore

enum Endpoint: String, Identifiable { case origin, destination; var id: String { rawValue } }

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var tab = 0
    @State private var editing: Endpoint?
    @State private var addingFavorite = false
    @State private var preferencesPresented = false
    @State private var selectedRoute: Itinerary?
    @State private var aboutPresented = false
    @State private var timePresented = false
    @State private var comparisonMode = "all"
    @State private var showsLiveVehicles = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var prefersShelteredTransit: Bool {
        comparisonMode == "all" && model.request.preferences.priority == .sheltered
    }
    private var comparedRoutes: [Itinerary] {
        guard let response = model.response else { return [] }
        if comparisonMode == "all" {
            return response.routes.filter { route in
                !prefersShelteredTransit || (route.legs.contains { $0.mode == .subway || $0.mode == .bus }
                    && route.legs.allSatisfy { $0.mode != .bike })
            }.map(model.resolvedRoute)
        }
        return (response.routeGroups?[comparisonMode] ?? response.routes.filter(matchesTravelMode)).map(model.resolvedRoute)
    }
    private func matchesTravelMode(_ route: Itinerary) -> Bool {
        if comparisonMode == "all" { return true }
        if comparisonMode == "walk" { return route.legs.allSatisfy { $0.mode == .walk } }
        return route.legs.contains { $0.mode.rawValue == comparisonMode }
            && (comparisonMode == "bike" || route.legs.allSatisfy { $0.mode.rawValue == comparisonMode || $0.mode == .walk })
    }
    private var walkingComparison: String? {
        guard comparisonMode == "all", !prefersShelteredTransit, let groups = model.response?.routeGroups,
              let walk = groups["walk"]?.map(\.minutes).min(), let bike = groups["bike"]?.map(\.minutes).min() else { return nil }
        return "Walk \(Int(ceil(walk))) min · With bike \(Int(ceil(bike))) min"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.up.right").font(.system(size: 21, weight: .heavy))
                    Text("crosstown").font(.system(size: 25, weight: .bold, design: .rounded)).tracking(-1)
                }
                Spacer()
                Button { aboutPresented = true } label: { DataPill().frame(minHeight: 44) }
                    .accessibilityLabel("Live data sources and server connection")
            }.padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 8)

            Group {
                if tab == 0 { planner }
                else if tab == 1 || tab == 2 {
                    TransitBoard(model: model, mode: tab == 1 ? .subway : .bus, onSources: { aboutPresented = true }).id(tab)
                }
                else if tab == 3 { BikeBoard(origin: model.origin) }
                else { savedJourneys }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack {
                tabButton("Explore", symbol: "arrow.triangle.turn.up.right.diamond.fill", index: 0)
                tabButton("Subway", symbol: "tram.fill", index: 1)
                tabButton("Bus", symbol: "bus.fill", index: 2)
                tabButton("Bike", symbol: "bicycle", index: 3)
                tabButton("Saved", symbol: "bookmark", index: 4)
            }.padding(.top, 10).padding(.horizontal, 10).background(.white)
                .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
        }
        .background(Theme.canvas).foregroundStyle(Theme.ink)
        .task(id: model.apiBaseURLString) { await model.refreshHealth(includeFeeds: false) }
        .onChange(of: [model.request.origin, model.request.destination]) { _, _ in comparisonMode = "all" }
        .task(id: model.request) {
            while !Task.isCancelled {
                await model.refresh()
                if model.health?.router.mode == "community" { return }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .sheet(item: $editing) { endpoint in
            PlacePicker(places: model.places, favorites: model.favoritePlaces,
                        title: endpoint == .origin ? "Start somewhere" : "Where to?", search: model.searchPlaces,
                        onUseCurrentLocation: endpoint == .origin ? { model.useCurrentLocation() } : nil,
                        onSave: model.saveFavorite) { model.select($0, endpoint: endpoint) }
        }
        .sheet(isPresented: $addingFavorite) {
            PlacePicker(places: model.places, favorites: model.favoritePlaces, title: "Add a saved place",
                        search: model.searchPlaces, onUseCurrentLocation: nil, onSave: model.saveFavorite, onSelect: nil)
        }
        .sheet(isPresented: $preferencesPresented) {
            PreferencesView(preferences: model.request.preferences, onApply: model.applyPreferences)
        }
        .sheet(item: $selectedRoute) { route in
            let current = comparedRoutes.first { $0.id == (route.groupId ?? route.id) } ?? model.resolvedRoute(route)
            RouteDetail(route: current, alternatives: model.departureOptions(for: current), onChooseDeparture: model.chooseDeparture, isSaved: model.isCurrentTripSaved, onSave: { model.save(route) }, onRefresh: { await model.refresh() })
        }
        .sheet(isPresented: $aboutPresented) { SourcesView(model: model) }
        .sheet(isPresented: $timePresented) {
            TripTimePicker(request: model.request) { departure, arrival, includeSchedules in
                model.request.departureMinute = 0; model.request.departureTime = departure; model.request.arrivalTime = arrival
                model.request.preferences.requireLiveTransit = !includeSchedules
            }
        }
    }

    private var planner: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ZStack(alignment: .top) {
                    JourneyMap(route: comparedRoutes.first, origin: model.origin, destination: model.destination,
                               apiBaseURLString: model.apiBaseURLString, showsLiveVehicles: showsLiveVehicles)
                        .frame(height: 285).clipShape(.rect(cornerRadius: 24))
                    VStack(spacing: 0) {
                        endpointButton(.origin, name: model.originLabel, symbol: "location.fill")
                        HStack(spacing: 12) {
                            Rectangle().fill(Theme.line).frame(height: 1)
                            Button { model.swap() } label: { Image(systemName: "arrow.up.arrow.down").font(.system(size: 13, weight: .semibold)).frame(width: 44, height: 32) }
                                .accessibilityLabel("Swap origin and destination")
                                .disabled(model.origin == nil || model.destination == nil)
                        }.padding(.leading, 40)
                        endpointButton(.destination, name: model.destination?.name ?? "Choose a destination", symbol: "mappin.circle.fill")
                    }.padding(12).background(.white, in: .rect(cornerRadius: 18))
                        .shadow(color: .black.opacity(0.06), radius: 12, y: 4).padding(12)
                    Button { showsLiveVehicles.toggle() } label: {
                        Image(systemName: showsLiveVehicles ? "tram.circle.fill" : "tram.circle").font(.title2)
                            .frame(width: 44, height: 44).background(.regularMaterial, in: Circle())
                    }.accessibilityLabel(showsLiveVehicles ? "Hide live vehicles" : "Show live vehicles")
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(10)
                }

                HStack {
                    Button { timePresented = true } label: {
                        Label(model.tripTimeLabel, systemImage: "clock").font(.subheadline.weight(.medium))
                    }.accessibilityLabel("Travel time: \(model.tripTimeLabel). Change departure or arrival time.")
                    Spacer()
                    Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }
                        .disabled(model.loading || model.locating).accessibilityLabel("Refresh live routes")
                }
                if model.locating { ProgressView("Finding your current location…") }
                else if model.origin == nil {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(model.locationError ?? "Use your current location or choose a starting address.")
                            .font(.subheadline).foregroundStyle(Theme.secondary)
                        Button("Use current location") { model.useCurrentLocation() }.buttonStyle(.borderedProminent)
                        Button("Choose a start") { editing = .origin }
                    }
                }
                if model.request.departureTime != nil || model.request.arrivalTime != nil {
                    Text(model.request.preferences.requireLiveTransit ? "Live predictions only. For future trips, include schedules in the time picker." : "Scheduled transit is included. Live predictions appear when available. Bike counts describe availability now.")
                        .font(.caption).foregroundStyle(Theme.secondary)
                }

                VStack(alignment: .leading, spacing: 13) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 7) {
                            ForEach(["all", "subway", "bus", "bike", "walk"], id: \.self) { mode in
                                Button { comparisonMode = mode } label: {
                                    Text(mode == "all" ? "Best" : mode.capitalized).font(.caption.weight(.semibold))
                                        .padding(.horizontal, 15).frame(minHeight: 44)
                                        .background(comparisonMode == mode ? Theme.blue.opacity(0.1) : .white, in: Capsule())
                                }.accessibilityAddTraits(comparisonMode == mode ? [.isSelected] : [])
                            }
                        }
                    }.accessibilityLabel("Compare travel options")
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("A better way there.").font(.system(size: 27, weight: .semibold)).tracking(-1)
                            Text("What matters on this trip?").font(.system(size: 14)).foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        Button { preferencesPresented = true } label: {
                            Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44).background(.white, in: Circle())
                        }.accessibilityLabel("Make it mine. Set travel modes, budget, walking and biking limits.")
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach([Priority.fastest, .cost, .aboveGround, .sheltered], id: \.self) { priority in
                                Button {
                                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { model.request.preferences.priority = priority }
                                } label: {
                                    Label(priority.title, systemImage: priority.symbol).font(.system(size: 13, weight: .semibold))
                                        .padding(.horizontal, 14).frame(height: 44)
                                        .background(model.request.preferences.priority == priority ? Theme.ink : .white, in: Capsule())
                                        .foregroundStyle(model.request.preferences.priority == priority ? .white : Theme.ink)
                                }.accessibilityAddTraits(model.request.preferences.priority == priority ? [.isSelected] : [])
                            }
                        }
                    }.contentMargins(.trailing, 2)
                }

                if model.loading && model.response == nil {
                    if let route = model.earlyRoute, matchesTravelMode(route) {
                        VStack(alignment: .leading, spacing: 8) {
                            ProgressView("Comparing more routes…").font(.subheadline)
                            Button { selectedRoute = route } label: {
                                HStack {
                                    Label(route.title, systemImage: "arrow.triangle.turn.up.right.diamond")
                                    Spacer()
                                    Text("\(Int(ceil(route.minutes))) min").monospacedDigit()
                                    Image(systemName: "chevron.right")
                                }.padding(12).frame(minHeight: 44).background(.white, in: .rect(cornerRadius: 14))
                            }.buttonStyle(.plain).accessibilityHint("Open the first available route")
                        }
                    } else {
                        ProgressView("Checking service times and streets…").frame(maxWidth: .infinity).padding()
                    }
                }
                if let error = model.error { ContentUnavailableView("Let’s try again", systemImage: "arrow.clockwise", description: Text(error)) }
                if model.response != nil {
                    HStack {
                        Text("\(comparedRoutes.count) ways to get there").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Text(comparedRoutes.first?.dataSummary ?? "Travel estimates").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                    }
                    if prefersShelteredTransit {
                        Text("Subway and bus trips ranked by estimated time outside.").font(.caption).foregroundStyle(Theme.secondary)
                    } else if let walkingComparison {
                        Text(walkingComparison).font(.caption).foregroundStyle(Theme.secondary)
                    }
                    if comparedRoutes.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "slider.horizontal.3").font(.title2)
                            Text("A little more room?").font(.title3.bold())
                            Text(prefersShelteredTransit ? "No subway or bus trip fits these limits. Try allowing a longer walk or additional transit modes." : "No reachable route fits these limits. Try allowing a longer walk, a higher budget, or another travel mode.").font(.subheadline).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
                            Button("Adjust my limits") { preferencesPresented = true }.buttonStyle(.borderedProminent)
                        }.frame(maxWidth: .infinity).padding(24).background(.white, in: .rect(cornerRadius: 22))
                    }
                    ForEach(Array(comparedRoutes.enumerated()), id: \.element.id) { index, route in
                        Button { selectedRoute = route } label: { RouteCard(route: route, recommended: index == 0, priority: model.request.preferences.priority) }
                            .buttonStyle(.plain)
                    }
                    Text("Street times and fares are estimates. Annual Citi Bike membership \(model.request.preferences.citiBikeMember ? "on" : "off"). Current bike reports are in Nearby bikes.")
                        .font(.system(size: 11)).foregroundStyle(Theme.secondary).lineSpacing(3).padding(.bottom, 12)
                }
            }.padding(.horizontal, 20).padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private func endpointButton(_ endpoint: Endpoint, name: String, symbol: String) -> some View {
        Button { editing = endpoint } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).foregroundStyle(endpoint == .origin ? Theme.blue : Theme.ink)
                Text(name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.secondary)
            }.frame(minHeight: 38).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("\(endpoint == .origin ? "From" : "To"): \(name). Change place.")
    }
    private func tabButton(_ name: String, symbol: String, index: Int) -> some View {
        Button { tab = index } label: {
            VStack(spacing: 5) { Image(systemName: symbol).font(.system(size: 20)); Text(name).font(.system(size: 10, weight: .semibold)) }
                .foregroundStyle(tab == index ? Theme.blue : Theme.secondary).frame(maxWidth: .infinity).frame(minHeight: 45)
        }.accessibilityAddTraits(tab == index ? [.isSelected] : [])
    }
    private var savedJourneys: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Saved places").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { addingFavorite = true } label: {
                        Label("Add a place", systemImage: "plus").frame(minHeight: 44)
                    }
                }
                ForEach(model.favoritePlaces) { favorite in
                    HStack(spacing: 8) {
                        Button { model.select(favorite.place, endpoint: .destination); tab = 0 } label: {
                            HStack(spacing: 13) {
                                Image(systemName: "mappin.circle.fill").foregroundStyle(Theme.blue)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(favorite.label).font(.subheadline.weight(.semibold))
                                    Text(favorite.place.name).font(.caption).foregroundStyle(Theme.secondary)
                                }
                                Spacer()
                            }.padding(.vertical, 13)
                        }.buttonStyle(.plain)
                        Button { model.removeFavorite(favorite) } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.accessibilityLabel("Remove \(favorite.label)")
                    }.padding(.leading, 13).background(.white, in: .rect(cornerRadius: 16))
                }
                Text("Saved trips").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                if model.saved.isEmpty {
                    Text("Open a route and tap the bookmark to save it here.").font(.subheadline).foregroundStyle(Theme.secondary)
                }
                ForEach(model.saved) { journey in
                    Button { model.openSaved(journey); tab = 0 } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "bookmark.fill").foregroundStyle(Theme.blue)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(journey.origin.name + " → " + journey.destination.name).font(.subheadline.weight(.semibold))
                                Text("Search again with current data").font(.caption).foregroundStyle(Theme.secondary)
                            }
                            Spacer(); Image(systemName: "arrow.up.right")
                        }.padding(20).background(.white, in: .rect(cornerRadius: 18))
                    }.buttonStyle(.plain)
                }
            }.padding(24)
        }
    }
}
