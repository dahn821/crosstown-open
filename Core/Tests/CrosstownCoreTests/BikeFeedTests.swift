import XCTest
@testable import CrosstownCore

final class BikeFeedTests: XCTestCase {
    func testDiscoveryFollowsPublishedURLsInsteadOfAssumingOldEndpoint() throws {
        let data = Data(#"{"data":{"en":{"feeds":[{"name":"station_information","url":"https://gbfs.lyft.com/info.json"},{"name":"station_status","url":"https://gbfs.lyft.com/status.json"}]}}}"#.utf8)
        let urls = try BikeFeedParser.feedURLs(data)
        XCTAssertEqual(urls.status.host, "gbfs.lyft.com")
    }

    func testRejectsUntrustedDiscoveryHosts() {
        let data = Data(#"{"data":{"en":{"feeds":[{"name":"station_information","url":"http://localhost/info"},{"name":"station_status","url":"https://example.com/status"}]}}}"#.utf8)
        XCTAssertThrowsError(try BikeFeedParser.feedURLs(data))
    }

    func testMixedBooleanFormatsMissingReportsAndOfflineStations() throws {
        let info = Data(#"{"data":{"stations":[{"station_id":"a","name":"Near","lat":40.75,"lon":-73.99},{"station_id":"b","name":"Offline","lat":40.75,"lon":-73.99}]}}"#.utf8)
        let status = Data(#"{"last_updated":1,"data":{"stations":[{"station_id":"a","num_bikes_available":3,"num_docks_available":0,"is_renting":1,"is_returning":true,"is_installed":1},{"station_id":"b","num_bikes_available":9,"num_docks_available":9,"is_renting":0,"is_returning":false,"is_installed":0}]}}"#.utf8)
        let snapshot = try BikeFeedParser.snapshot(information: info, status: status, near: .init(40.75,-73.99))
        XCTAssertEqual(snapshot.stations.count, 1)
        XCTAssertTrue(snapshot.isStale)
        XCTAssertTrue(snapshot.stations[0].isStale)
        XCTAssertEqual(snapshot.stations[0].docks, 0)
        XCTAssertTrue(snapshot.stations[0].isRenting)
    }
}
