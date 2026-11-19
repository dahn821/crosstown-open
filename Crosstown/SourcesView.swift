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
        let choices = Set((board?.departures.map(\.line) ?? []) + [selectedLine])
        return choices.union(availableLines).filter { !$0.isEmpty }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
    private var requestedLine: String? { selectedLine.isEmpty ? nil : selectedLine }
    private var activeStation: TransitStation? { board?.stations?.first(where: { $0.id == selectedStop }) ?? board?.stations?.first }
    private var queryID: String { "\(model.apiBaseURLString)|\(near.latitude),\(near.longitude)|\(focus?.id ?? "")|\(requestedLine ?? "")" }

    var body: some View {
        VStack(spacing: 0) {
            JourneyMap(route: nil, origin: model.origin, destination: nil, apiBaseURLString: model.apiBaseURLString,
                       liveMode: mode, busStops: busStops, selectedLine: selectedLine,
                       highlightedStations: Set([activeStation?.id].compactMap { $0 }),
                       onCenterChange: { next in
                           if center != next { focus = nil; selectedStop = nil }
                           center = next
                       },
                       onStop: { id, name, coordinate in focus = Place(id: id, name: name, neighborhood: "New York City", coordinate: coordinate) })
                .frame(minHeight: 230, maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(focus?.name ?? (mode == .bus ? "Bus arrivals" : "Subway arrivals"))
                        .font(.headline).lineLimit(1).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 5)
                    Picker("Line", selection: $selectedLine) {
                        Text("All lines").tag("")
                        ForEach(lines, id: \.self) { Text(mode == .subway ? SubwayBadge.name($0) : $0).tag($0) }
                    }.pickerStyle(.menu).labelsHidden().accessibilityLabel("Filter by line")
                    Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise").frame(width: 38, height: 38) }
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
                    if loading && board == nil { ProgressView("Checking MTA predictions…") }
                    if let error {
                        Text(error).font(.subheadline).foregroundStyle(Theme.secondary)
                        Button("Check Sources", action: onSources)
                    }
                    if let board { departureSection(board: board) }
                }.padding(.horizontal, 17).padding(.vertical, 8)
            }.frame(height: 150).refreshable { await refresh() }.id(queryID + (selectedStop ?? ""))
        }
        .task(id: queryID) {
            board = nil
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
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
        let seconds = (transitDate(departure.departureTime) ?? now).timeIntervalSince(now)
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
                Text(seconds < -30 ? "Departed" : seconds < 60 ? "Due" : "\(Int(ceil(seconds / 60))) min").font(.headline).foregroundStyle(Theme.green)
                Text(transitClock(departure.departureTime)).font(.caption).foregroundStyle(Theme.secondary)
            }
        }.padding(.vertical, 8)
    }
    private func subwayStation(_ station: TransitStation, now: Date, stale: Bool) -> some View {
        let journeys = arrivals.filter { $0.stationId == station.id && (transitDate($0.departureTime) ?? .distantPast) >= now }
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
                                let seconds = (transitDate(departure.departureTime) ?? now).timeIntervalSince(now)
                                HStack(spacing: 4) {
                                    SubwayBadge(line: departure.line, reportedColor: departure.routeColor, size: 18)
                                    Text(seconds < 60 ? "Due" : "\(Int(ceil(seconds / 60))) min").font(.caption).monospacedDigit()
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
                        Text(first.line).font(.caption.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 5)
                            .background(Theme.mode(.bus), in: .rect(cornerRadius: 7))
                        Text(first.direction ?? "Live arrival").font(.caption).foregroundStyle(Theme.secondary)
                        Spacer(minLength: 4)
                        ForEach(trips.prefix(3)) { departure in
                            let seconds = (transitDate(departure.departureTime) ?? now).timeIntervalSince(now)
                            Text(seconds < 60 ? "Due" : "\(Int(ceil(seconds / 60)))m")
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
    let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
private func transitClock(_ value: String) -> String {
    guard let date = transitDate(value) else { return "—" }
    let formatter = DateFormatter(); formatter.timeZone = TimeZone(identifier: "America/New_York"); formatter.dateFormat = "h:mm:ss a"
    return formatter.string(from: date)
}

struct PlacePicker: View {
    let places: [Place]
    let title: String
    let search: (String) async throws -> [Place]
    let onUseCurrentLocation: (() -> Void)?
    let onSelect: (Place) -> Void
    @State private var query = ""
    @State private var results: [Place] = []
    @State private var loading = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if let onUseCurrentLocation {
                    Button { onUseCurrentLocation(); dismiss() } label: {
                        Label("Use current location", systemImage: "location.fill")
                    }
                }
                if loading { ProgressView("Searching NYC…") }
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.secondary) }
                Section(query.isEmpty ? "Recent places" : "Places") {
                    ForEach(results) { place in
                        Button { onSelect(place); dismiss() } label: {
                            HStack(spacing: 15) {
                                Image(systemName: "mappin").foregroundStyle(Theme.blue).frame(width: 23)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(place.name).foregroundStyle(Theme.ink)
                                    Text(place.neighborhood).font(.caption).foregroundStyle(Theme.secondary)
                                }
                            }.padding(.vertical, 7)
                        }
                    }
                }
            }.searchable(text: $query, prompt: "Search places, restaurants or addresses").navigationTitle(title)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .task(id: query) {
                    if query.isEmpty { results = places.filter { $0.id != PlanRequest.currentLocationID }; loading = false; return }
                    loading = true; results = []; error = nil
                    do {
                        try await Task.sleep(for: .milliseconds(500))
                        let found = try await search(query)
                        guard !Task.isCancelled else { return }
                        results = found; error = nil
                    } catch is CancellationError { return }
                    catch { self.error = error.localizedDescription }
                    loading = false
                }
        }.presentationDragIndicator(.visible)
    }
}
