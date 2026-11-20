import SwiftUI
import CrosstownCore

struct SourcesView: View {
    @Bindable var model: AppModel
    @State private var server = ""
    @State private var connecting = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Current information.\nClear about the gaps.").font(.title2.weight(.semibold))
                    Text("Route searches use MTA stop predictions, current Citi Bike reports, and street paths. Street times, fares and outdoor exposure are estimates.").font(.subheadline).foregroundStyle(Theme.secondary)
                }
                Section("Live feeds") {
                    HStack { Text("NYC routing"); Spacer(); Text(model.health?.router.ready == true ? "Connected" : "Not connected").foregroundStyle(Theme.secondary) }
                    HStack { Text("Subway"); Spacer(); Text("\(model.health?.feeds.subway.filter { !$0.stale }.count ?? 0) / 8 feeds current").foregroundStyle(Theme.secondary) }
                    HStack { Text("Citi Bike"); Spacer(); Text(model.health?.feeds.bikes.stale == false ? "Current reports" : "Unavailable / stale").foregroundStyle(Theme.secondary) }
                    HStack { Text("Bus Time"); Spacer(); Text(model.health?.feeds.bus.configured == true ? (model.health?.feeds.bus.stale == false ? "Current reports" : "Unavailable / stale") : "API key needed").foregroundStyle(Theme.secondary) }
                    if model.health?.feeds.bus.configured != true {
                        Text("Connect the key from MTA’s email in the web app’s Sources → Connect Bus Time field on the Mac running Crosstown. Keep the key out of chat.").font(.footnote).foregroundStyle(Theme.secondary)
                        if let setup = URL(string: model.apiBaseURLString + "/?setup=bus-time"), ["localhost", "127.0.0.1", "::1"].contains(setup.host ?? "") {
                            Link("Open private Bus Time setup", destination: setup)
                        }
                    }
                    Text("A transit leg is labeled live only when the current feed reports a reachable train or bus at both your boarding and alighting stops. Turn off live-only transit to compare schedules.").font(.footnote).foregroundStyle(Theme.secondary)
                }
                Section("Your route server") {
                    TextField("http://your-mac.local:4173", text: $server).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button(connecting ? "Connecting…" : "Connect") {
                        connecting = true
                        Task { await model.configureServer(server); connecting = false }
                    }.disabled(connecting)
                    if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.secondary) }
                    Text("The iPhone simulator connects to localhost:4173 after you start Crosstown on your Mac. A physical iPhone needs an address it can reach on your local network or an HTTPS server.").font(.footnote).foregroundStyle(Theme.secondary)
                }
                Section("Sources") {
                    if model.health?.router.mode == "community" {
                        Link("Transitous data sources", destination: URL(string: "https://transitous.org/sources/")!)
                        Text("Trip coordinates are sent to Transitous for routing. Tap Refresh to request a new plan.").font(.footnote).foregroundStyle(Theme.secondary)
                    }
                    Link("MTA data", destination: URL(string: "https://www.mta.info/developers")!)
                    Link("Citi Bike reports", destination: URL(string: "https://citibikenyc.com/system-data")!)
                    Link("Request a Bus Time key", destination: URL(string: "https://register.developer.obanyc.com/")!)
                }
            }.navigationTitle("Sources & connection").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .task { server = model.apiBaseURLString; await model.refreshHealth() }
        }.presentationDragIndicator(.visible)
    }
}

private enum TripTimeMode: String, CaseIterable {
    case now = "Leave now", departAt = "Depart at", arriveBy = "Arrive by"
}

struct TripTimePicker: View {
    let request: PlanRequest
    let onApply: (Date?, Date?, Bool) -> Void
    @State private var mode: TripTimeMode
    @State private var date: Date
    @State private var includeSchedules: Bool
    @Environment(\.dismiss) private var dismiss

    init(request: PlanRequest, onApply: @escaping (Date?, Date?, Bool) -> Void) {
        self.request = request; self.onApply = onApply
        _mode = State(initialValue: request.arrivalTime != nil ? .arriveBy : request.departureTime != nil ? .departAt : .now)
        _date = State(initialValue: request.arrivalTime ?? request.departureTime ?? Date().addingTimeInterval(900))
        _includeSchedules = State(initialValue: !request.preferences.requireLiveTransit)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Travel time", selection: $mode) {
                        ForEach(TripTimeMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                    if mode != .now {
                        DatePicker(mode.rawValue, selection: $date, in: Date()...Date().addingTimeInterval(14 * 86400), displayedComponents: [.date, .hourAndMinute])
                            .environment(\.timeZone, TimeZone(identifier: "America/New_York")!)
                        Text("All times are New York time. Choose a time within the next 14 days.").font(.footnote).foregroundStyle(Theme.secondary)
                    }
                }
                if mode != .now {
                    Section("Transit predictions") {
                        Toggle("Include scheduled transit", isOn: $includeSchedules)
                        Text("MTA reports trains and buses currently in service. Future trips need published schedules. Each transit leg shows whether its time is live or scheduled.").font(.footnote).foregroundStyle(Theme.secondary)
                        Text("Current bike and dock counts do not predict availability at your selected time.").font(.footnote).foregroundStyle(Theme.secondary)
                    }
                }
            }
            .navigationTitle("Trip time").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply time") {
                        onApply(mode == .departAt ? date : nil, mode == .arriveBy ? date : nil, mode == .now ? !request.preferences.requireLiveTransit : includeSchedules)
                        dismiss()
                    }.disabled(mode != .now && date < Date().addingTimeInterval(-60))
                }
            }
            .onChange(of: mode) { _, value in if value != .now { includeSchedules = true } }
        }.presentationDragIndicator(.visible)
    }
}

struct TransitBoard: View {
    @Bindable var model: AppModel
    let mode: TravelMode
    let onSources: () -> Void
    @State private var board: TransitDepartures?
    @State private var error: String?
    @State private var loading = false
    @State private var center: Coordinate?
    @State private var focus: Place?
    @State private var selectedStop: String?
    @State private var selectedLine = ""
    @State private var availableLines = Set<String>()
    @State private var observedTrains: [String: LiveVehicle] = [:]
    @State private var refreshMap = 0
    @State private var choosingLine = false
    @State private var lineQuery = ""

    private var near: Coordinate { focus?.coordinate ?? center ?? model.origin?.coordinate ?? Coordinate(40.7505, -73.9934) }
    private var arrivals: [TransitDeparture] {
        board?.departures.filter { $0.mode == mode && (selectedLine.isEmpty || $0.line == selectedLine) } ?? []
    }
    private var busStops: [Place] {
        guard mode == .bus else { return [] }
        if let stations = board?.stations {
            return stations.map { Place(id: $0.id, name: $0.name, neighborhood: "New York City", coordinate: $0.coordinate) }
        }
        var seen = Set<String>()
        return arrivals.map(\.stop).filter { seen.insert($0.id).inserted }
    }
    private var lines: [String] {
        let nearby = Set(board?.departures.map(\.line) ?? [])
        let choices = nearby.union(availableLines).union([selectedLine])
        let query = lineQuery.filter { $0.isLetter || $0.isNumber }.lowercased()
        return choices.filter { line in
            guard !line.isEmpty else { return false }
            return query.isEmpty || line.filter { $0.isLetter || $0.isNumber }.lowercased().contains(query)
                || lineName(line).filter { $0.isLetter || $0.isNumber }.lowercased().contains(query)
        }.sorted { first, second in
            if nearby.contains(first) != nearby.contains(second) { return nearby.contains(first) }
            return first.localizedStandardCompare(second) == .orderedAscending
        }
    }
    private var allLinesTitle: String { mode == .bus ? "All bus routes" : "All subway lines" }
    private func lineName(_ line: String) -> String { mode == .subway ? SubwayBadge.name(line) : line }
    private var requestedLine: String? { selectedLine.isEmpty ? nil : selectedLine }
    private var activeStation: TransitStation? { board?.stations?.first(where: { $0.id == selectedStop }) ?? board?.stations?.first }
    private var queryID: String { "\(model.apiBaseURLString)|\(near.latitude),\(near.longitude)|\(focus?.id ?? "")|\(requestedLine ?? "")" }

    var body: some View {
        VStack(spacing: 0) {
            JourneyMap(route: nil, origin: model.origin, destination: nil, apiBaseURLString: model.apiBaseURLString,
                       liveMode: mode, busStops: busStops, selectedLine: selectedLine,
                       boardLocation: mode == .subway ? near : nil, boardStop: focus?.id, refreshRequest: refreshMap,
                       highlightedStations: Set([activeStation?.id].compactMap { $0 }),
                       stationPredictions: mode == .subway ? arrivals.filter { $0.stationId == activeStation?.id } : [],
                       onCenterChange: { next in
                           if center != next { focus = nil; selectedStop = nil }
                           center = next
                       },
                       onStop: { id, name, coordinate in focus = Place(id: id, name: name, neighborhood: "New York City", coordinate: coordinate) },
                       onVehicleSnapshot: { snapshot in
                           availableLines.formUnion(snapshot?.availableLines ?? [])
                           if mode == .subway {
                               observedTrains = Dictionary((snapshot?.vehicles ?? []).compactMap { row in row.trackingId.map { ($0, row) } },
                                                           uniquingKeysWith: { $0.reportedDate > $1.reportedDate ? $0 : $1 })
                               if let arrivals = snapshot?.board {
                                   board = arrivals; error = nil; loading = false
                               } else if snapshot != nil {
                                   Task { await refresh() }
                               } else {
                                   board = nil; error = "Current subway reports are unavailable."; loading = false
                               }
                           }
                       })
                .frame(minHeight: 230, maxHeight: .infinity)
                .overlay(alignment: .topLeading) {
                    Button { lineQuery = ""; choosingLine = true } label: {
                        HStack(spacing: 7) {
                            Text(selectedLine.isEmpty ? allLinesTitle : lineName(selectedLine)).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2)
                        }.font(.subheadline.weight(.semibold)).padding(.horizontal, 10).frame(minHeight: 44)
                            .background(.regularMaterial, in: .rect(cornerRadius: 10))
                    }.buttonStyle(.plain).padding(9)
                    .accessibilityHint(mode == .bus ? "Choose a bus route" : "Choose a subway line")
                }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(focus?.name ?? (mode == .bus ? "Bus arrivals" : "Subway arrivals"))
                        .font(.headline).lineLimit(1).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 5)
                    Button { Task { await reload() } } label: { Image(systemName: "arrow.clockwise").frame(width: 38, height: 38) }
                        .disabled(loading).accessibilityLabel("Refresh arrivals")
                }
                if focus != nil {
                    Button(mode == .subway ? "‹ Nearby stations" : "‹ Nearby stops") {
                        focus = nil; selectedStop = nil
                    }.font(.subheadline)
                } else {
                    Text(mode == .subway ? "Drag the map to find nearby stations" : "Drag the map to find nearby stops")
                        .font(.caption).foregroundStyle(Theme.secondary)
                }
            }.padding(.horizontal, 18).padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading).background(.white)
            if focus == nil, let stations = board?.stations, !stations.isEmpty {
                nearbyPicker(stations)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if board == nil && error == nil { ProgressView("Checking live transit…") }
                    if let error {
                        Text(error).font(.subheadline).foregroundStyle(Theme.secondary)
                        Button("Check Sources", action: onSources)
                    }
                    if let board { departureSection(board: board) }
                }.padding(.horizontal, 17).padding(.vertical, 8)
            }.frame(height: 150).refreshable { await reload() }.id(queryID + (selectedStop ?? ""))
        }
        .task(id: queryID) {
            guard mode == .bus else { return }
            board = nil
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .sheet(isPresented: $choosingLine) {
            NavigationStack {
                List {
                    lineChoice("")
                    ForEach(lines, id: \.self) { lineChoice($0) }
                    if lines.isEmpty, !lineQuery.isEmpty { Text("No matching lines in current service.").font(.footnote) }
                }.searchable(text: $lineQuery, prompt: mode == .bus ? "Find a bus route" : "Find a subway line")
                    .navigationTitle(mode == .bus ? "Choose a bus route" : "Choose a subway line")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { choosingLine = false } } }
            }.presentationDragIndicator(.visible)
        }
    }
    private func lineChoice(_ line: String) -> some View {
        Button { chooseLine(line); choosingLine = false } label: {
            HStack(spacing: 8) {
                if mode == .subway, !line.isEmpty { SubwayBadge(line: line, reportedColor: nil) }
                if line.isEmpty || mode == .bus || lineName(line) != line || line.count > 1 {
                    Text(line.isEmpty ? allLinesTitle : lineName(line))
                }
                Spacer()
                if selectedLine == line { Image(systemName: "checkmark") }
            }.frame(minHeight: 34)
        }.accessibilityLabel(line.isEmpty ? allLinesTitle : lineName(line))
            .accessibilityAddTraits(selectedLine == line ? [.isSelected] : [])
    }
    private func chooseLine(_ line: String) {
        guard selectedLine != line else { return }
        board = nil; focus = nil; selectedStop = nil; observedTrains = [:]; error = nil
        selectedLine = line
    }
    private func departureSection(board: TransitDepartures) -> some View {
        return VStack(alignment: .leading, spacing: 12) {
            if mode == .bus && board.feedStatus.bus.configured != true {
                Text("Bus Time needs a connection.").font(.subheadline).foregroundStyle(Theme.secondary)
                Button("Open Sources", action: onSources)
            } else if board.stations != nil {
                if let station = activeStation {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if mode == .subway {
                            subwayStation(station, now: context.date, stale: board.feedStatus.subway.allSatisfy(\.stale))
                        } else {
                            busArrivals(station, now: context.date, stale: board.feedStatus.bus.stale)
                        }
                    }
                } else {
                    Text(requestedLine == nil ? "No stops near the map marker." : "Drag toward this line or choose All lines.")
                        .font(.subheadline).foregroundStyle(Theme.secondary)
                }
            } else if arrivals.isEmpty {
                Text((mode == .bus ? board.feedStatus.bus.stale : board.feedStatus.subway.allSatisfy(\.stale)) ? "Current MTA predictions are unavailable." : "No upcoming departures reported here.")
                    .font(.subheadline).foregroundStyle(Theme.secondary)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LazyVStack(spacing: 0) {
                        ForEach(arrivals.prefix(24)) { departure in
                            Button { focus = departure.stop } label: { departureRow(departure, now: context.date) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func nearbyPicker(_ stations: [TransitStation]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(stations) { station in
                    let selected = activeStation?.id == station.id
                    Button { selectedStop = station.id } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(station.name).lineLimit(1).font(.caption.weight(.semibold))
                            let feet = Int((station.metersAway * 3.28084 / 25).rounded()) * 25
                            Text(feet < 100 ? "At map center" : "\(feet.formatted()) ft away")
                                .font(.caption2).foregroundStyle(Theme.secondary)
                        }.padding(.horizontal, 10).frame(minHeight: 44).padding(.vertical, 2)
                            .background(selected ? Theme.blue.opacity(0.13) : .white, in: .rect(cornerRadius: 10))
                    }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }.padding(.horizontal, 17)
        }.padding(.vertical, 4).accessibilityLabel("Nearby transit stops")
    }
    private func departureRow(_ departure: TransitDeparture, now: Date) -> some View {
        let age = max(0, Int(now.timeIntervalSince(transitDate(departure.predictionReportedAt) ?? now)))
        return HStack(alignment: .top, spacing: 12) {
            if departure.mode == .subway {
                SubwayBadge(line: departure.line, reportedColor: departure.routeColor)
            } else {
                Text(departure.line).font(.caption.bold()).foregroundStyle(.white).padding(8)
                    .background(Theme.mode(departure.mode), in: .rect(cornerRadius: 10))
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(departure.stop.name).font(.subheadline.weight(.semibold))
                Text(departure.direction ?? "Live MTA prediction")
                    .font(.caption).foregroundStyle(Theme.secondary)
                Text("MTA report \(age)s ago").font(.caption2).foregroundStyle(Theme.secondary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 5) {
                Text(countdown(departure, at: now) ?? "—").font(.headline).foregroundStyle(Theme.green)
                Text(transitClock(departure.arrivalTime ?? departure.departureTime)).font(.caption).foregroundStyle(Theme.secondary)
            }
        }.padding(.vertical, 8)
    }
    private func subwayStation(_ station: TransitStation, now: Date, stale: Bool) -> some View {
        let journeys = arrivals.filter { $0.stationId == station.id && countdown($0, at: now) != nil }
        let groups = Dictionary(grouping: journeys) { $0.direction ?? "Upcoming trains" }
        let directions = groups.keys.sorted {
            if $0 == "Uptown" { return $1 != "Uptown" }
            if $1 == "Uptown" { return false }
            return $0 < $1
        }
        return VStack(alignment: .leading, spacing: 8) {
            if directions.isEmpty {
                Text(stale ? "MTA predictions unavailable." : "No live departures reported.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(directions, id: \.self) { direction in
                HStack {
                    Text(direction).font(.caption.weight(.semibold)).foregroundStyle(Theme.secondary).frame(width: 82, alignment: .leading)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 5) {
                            ForEach(displayedTrains(groups[direction] ?? [])) { departure in
                                HStack(spacing: 4) {
                                    SubwayBadge(line: departure.line, reportedColor: departure.routeColor, size: 18)
                                    Text(countdown(departure, at: now) ?? "—").font(.caption).monospacedDigit()
                                }.padding(.horizontal, 5).padding(.vertical, 3)
                                    .background(.white, in: Capsule())
                            }
                        }
                    }
                }
            }
            if focus == nil, !journeys.isEmpty {
                Button("All departures") {
                    focus = Place(id: station.id, name: station.name, neighborhood: "New York City", coordinate: station.coordinate)
                }.font(.subheadline)
            }
        }.padding(.vertical, 7).accessibilityElement(children: .contain)
    }
    private func busArrivals(_ station: TransitStation, now: Date, stale: Bool) -> some View {
        let journeys = arrivals.filter { $0.stationId == station.id && (transitDate($0.departureTime) ?? .distantPast) >= now }
        let group: (TransitDeparture) -> String = { $0.line + "|" + ($0.direction ?? "") }
        let groups = Dictionary(grouping: journeys, by: group)
        let keys = groups.keys.sorted { (groups[$0]?.first?.departureTime ?? "") < (groups[$1]?.first?.departureTime ?? "") }
        return VStack(alignment: .leading, spacing: 8) {
            if keys.isEmpty {
                Text(stale ? "MTA predictions unavailable." : "No live departures reported.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(keys, id: \.self) { key in
                if let trips = groups[key], let first = trips.first {
                    HStack(spacing: 8) {
                        Button { chooseLine(first.line) } label: {
                            Text(first.line).font(.caption.bold()).foregroundStyle(.white)
                                .padding(.horizontal, 7).padding(.vertical, 5)
                                .background(Theme.mode(.bus), in: .rect(cornerRadius: 7))
                        }.buttonStyle(.plain).accessibilityLabel("Show route \(first.line)").disabled(requestedLine != nil)
                        Text(first.direction ?? "Live arrival").font(.caption).foregroundStyle(Theme.secondary)
                        Spacer(minLength: 4)
                        ForEach(trips.prefix(3)) { departure in
                            Text(TransitArrival.label(arrival: departure.arrivalTime, departure: departure.departureTime, now: now))
                                .font(.caption.monospacedDigit()).padding(5).background(.white, in: Capsule())
                        }
                    }
                }
            }
        }.padding(.vertical, 7)
    }
    private func displayedTrains(_ arrivals: [TransitDeparture]) -> [TransitDeparture] {
        if focus != nil { return Array(arrivals.prefix(12)) }
        var seen = Set<String>()
        return Array(arrivals.filter { seen.insert($0.line).inserted }.prefix(4))
    }
    private func countdown(_ departure: TransitDeparture, at time: Date) -> String? {
        departure.countdown(vehicle: departure.trackingId.flatMap { observedTrains[$0] }, now: time)
    }
    private func reload() async {
        if mode == .subway { loading = true; refreshMap += 1 }
        else { await refresh() }
    }
    private func refresh() async {
        guard let url = URL(string: model.apiBaseURLString) else { return }
        let key = queryID, coordinate = near, stop = focus?.id
        loading = true
        do {
            let result = try await LiveRoutingClient(baseURL: url).departures(near: coordinate, mode: mode, stop: stop, line: requestedLine)
            guard !Task.isCancelled, key == queryID else { return }
            board = result; error = nil
            if requestedLine == nil { availableLines.formUnion(result.departures.map(\.line)) }
        } catch {
            guard !Task.isCancelled, key == queryID else { return }
            board = nil; self.error = error.localizedDescription
        }
        loading = false
    }
}

private func transitDate(_ value: String) -> Date? {
    TransitArrival.date(value)
}
private func transitClock(_ value: String) -> String {
    guard let date = transitDate(value) else { return "—" }
    let formatter = DateFormatter(); formatter.timeZone = TimeZone(identifier: "America/New_York"); formatter.dateFormat = "h:mm:ss a"
    return formatter.string(from: date)
}

struct PlacePicker: View {
    let places: [Place]
    let favorites: [FavoritePlace]
    let title: String
    let search: (String, Bool) async throws -> PlaceSuggestions
    let onUseCurrentLocation: (() -> Void)?
    let onSave: (Place, String) -> Void
    let onSelect: ((Place) -> Void)?
    @State private var query = ""
    @State private var results: [Place] = []
    @State private var loading = false
    @State private var error: String?
    @State private var favoriteTarget: Place?
    @State private var namingFavorite = false
    @State private var favoriteLabel = ""
    @Environment(\.dismiss) private var dismiss

    private var foundFavorites: [FavoritePlace] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return favorites.filter { text.isEmpty || $0.label.localizedCaseInsensitiveContains(text) || $0.place.name.localizedCaseInsensitiveContains(text) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let onUseCurrentLocation {
                    Button { onUseCurrentLocation(); dismiss() } label: {
                        Label("Use current location", systemImage: "location.fill")
                    }
                }
                if onSelect != nil, !foundFavorites.isEmpty {
                    Section("Saved places") {
                        ForEach(foundFavorites) { favorite in
                            Button { select(favorite.place) } label: { placeRow(favorite.label, favorite.place.name, symbol: "bookmark.fill") }
                        }
                    }
                }
                Section(query.isEmpty ? "Recent places" : "Places") {
                    ForEach(results) { place in
                        HStack {
                            Button { select(place) } label: { placeRow(place.name, place.neighborhood, symbol: "mappin") }.buttonStyle(.plain)
                            if onSelect != nil {
                                Button { name(place) } label: { Image(systemName: "bookmark").frame(width: 44, height: 44) }
                                    .buttonStyle(.borderless).accessibilityLabel("Save \(place.name)")
                            }
                        }
                    }
                    if loading { ProgressView("Searching NYC…") }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.secondary) }
                }
            }.searchable(text: $query, prompt: "Search places, restaurants or addresses").navigationTitle(title)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .task(id: query) { await updateResults() }
                .alert("Save place", isPresented: $namingFavorite, presenting: favoriteTarget) { place in
                    TextField("Home, Work, or another name", text: $favoriteLabel)
                    Button("Save place") {
                        let label = String(favoriteLabel.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
                        guard !label.isEmpty else { return }
                        onSave(place, label)
                        if onSelect == nil { dismiss() }
                    }.disabled(favoriteLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel", role: .cancel) { }
                } message: { place in
                    Text(place.name)
                }
        }.presentationDragIndicator(.visible)
    }
    private func select(_ place: Place) {
        if let onSelect { onSelect(place); dismiss() }
        else { name(place) }
    }
    private func name(_ place: Place) {
        favoriteTarget = place
        favoriteLabel = favorites.first { $0.id == place.id }?.label ?? ""
        namingFavorite = true
    }
    private func placeRow(_ title: String, _ subtitle: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Theme.blue).frame(width: 23)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).foregroundStyle(Theme.ink)
                Text(subtitle).font(.caption).foregroundStyle(Theme.secondary)
            }
            Spacer()
        }.padding(.vertical, 7).contentShape(Rectangle())
    }
    private func updateResults() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        error = nil; loading = false
        if text.isEmpty { results = places.filter { $0.id != PlanRequest.currentLocationID }; return }
        results = []
        guard text.count >= 2 else { return }
        loading = true
        do {
            try await Task.sleep(for: .milliseconds(150))
            if text.first?.isNumber != true {
                let nearby = try await search(text, true)
                try Task.checkCancellation()
                results = nearby.places
                if nearby.complete != false { loading = false; return }
            }
            let found = try await search(text, false)
            try Task.checkCancellation()
            results = found.places
            if results.isEmpty { error = "No matches in NYC. Try a street address or landmark." }
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
        loading = false
    }
}
