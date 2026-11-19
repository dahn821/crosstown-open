import SwiftUI
import MapKit
import CrosstownCore

enum Endpoint: String, Identifiable { case origin, destination; var id: String { rawValue } }

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var tab = 0
    @State private var editing: Endpoint?
    @State private var preferencesPresented = false
    @State private var selectedRoute: Itinerary?
    @State private var aboutPresented = false
    @State private var timePresented = false
    @State private var vehicleMapPresented = false
    @State private var comparisonMode = "all"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var comparedRoutes: [Itinerary] {
        guard let response = model.response else { return [] }
        if comparisonMode == "all" { return response.routes.map(model.resolvedRoute) }
        return (response.routeGroups?[comparisonMode] ?? response.routes.filter { route in
            comparisonMode == "walk" ? route.legs.allSatisfy { $0.mode == .walk } : route.legs.contains { $0.mode.rawValue == comparisonMode }
        }).map(model.resolvedRoute)
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
                else if tab == 1 { TransitBoard(model: model, onSources: { aboutPresented = true }, onMap: { vehicleMapPresented = true }) }
                else if tab == 2 { BikeBoard(origin: model.origin, onChooseStart: { editing = .origin }) }
                else { savedJourneys }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack {
                tabButton("Explore", symbol: "arrow.triangle.turn.up.right.diamond.fill", index: 0)
                tabButton("Live transit", symbol: "tram.fill", index: 1)
                tabButton("Nearby bikes", symbol: "bicycle", index: 2)
                tabButton("Saved", symbol: "bookmark", index: 3)
            }.padding(.top, 10).padding(.horizontal, 20).background(.white)
                .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
        }
        .background(Theme.canvas).foregroundStyle(Theme.ink)
        .task(id: model.request) {
            while !Task.isCancelled {
                await model.refresh()
                if model.health?.router.mode == "community" { return }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .sheet(item: $editing) { endpoint in
            PlacePicker(places: model.places, title: endpoint == .origin ? "Start somewhere" : "Where to?", search: model.searchPlaces, onUseCurrentLocation: endpoint == .origin ? { model.useCurrentLocation() } : nil) { place in
                model.select(place, endpoint: endpoint)
            }
        }
        .sheet(isPresented: $preferencesPresented) {
            PreferencesView(preferences: model.request.preferences) { model.request.preferences = $0 }
        }
        .sheet(item: $selectedRoute) { route in
            let current = ([model.response?.routes ?? []] + Array(model.response?.routeGroups?.values ?? [:].values)).flatMap { $0 }.first { $0.id == (route.groupId ?? route.id) } ?? route
            RouteDetail(route: model.resolvedRoute(current), alternatives: model.departureOptions(for: current), onChooseDeparture: model.chooseDeparture, isSaved: model.isCurrentTripSaved, onSave: { model.save(route) }, onRefresh: { await model.refresh() }, apiBaseURLString: model.apiBaseURLString)
        }
        .sheet(isPresented: $aboutPresented) { SourcesView(model: model) }
        .fullScreenCover(isPresented: $vehicleMapPresented) {
            LiveVehicleMapScreen(apiBaseURLString: model.apiBaseURLString, origin: model.origin, destination: model.destination, route: model.response?.routes.first)
        }
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
                    JourneyMap(route: comparedRoutes.first, origin: model.origin, destination: model.destination, apiBaseURLString: model.apiBaseURLString)
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
                    Text("STREET ROUTE").font(.system(size: 8, weight: .semibold, design: .monospaced)).tracking(1)
                        .padding(7).background(Theme.canvas.opacity(0.94), in: Capsule()).frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 12)
                }

                HStack {
                    Button { timePresented = true } label: {
                        Label(model.tripTimeLabel, systemImage: "clock").font(.subheadline.weight(.medium))
                    }.accessibilityLabel("Travel time: \(model.tripTimeLabel). Change departure or arrival time.")
                    Spacer()
                    Button { vehicleMapPresented = true } label: { Label("Live map", systemImage: "map").font(.caption.weight(.medium)) }
                        .accessibilityLabel("Open live vehicle map")
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

                if model.loading && model.response == nil { ProgressView("Finding combinations…").frame(maxWidth: .infinity).padding() }
                if let error = model.error { ContentUnavailableView("Let’s try again", systemImage: "arrow.clockwise", description: Text(error)) }
                if model.response != nil {
                    HStack {
                        Text("\(comparedRoutes.count) ways to get there").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Text(model.response?.routes.first?.dataSummary ?? "Travel estimates").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                    }
                    if comparedRoutes.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "slider.horizontal.3").font(.title2)
                            Text("A little more room?").font(.title3.bold())
                            Text("No reachable route fits these limits. Try allowing a longer walk, a higher budget, or another travel mode.").font(.subheadline).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
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
                Text("Your good finds.").font(.system(size: 32, weight: .semibold)).tracking(-1)
                Text("Saved trips search again with current data.").font(.subheadline).foregroundStyle(Theme.secondary)
                if model.saved.isEmpty {
                    ContentUnavailableView("Keep a good connection", systemImage: "bookmark", description: Text("Open a route and tap the bookmark to save it here."))
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
