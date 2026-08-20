import Combine
import SwiftUI

/// Where a people search lives when it's a screen of its own, pushed from the
/// Home toolbar. A case rather than a bare marker so `ojoDestinations` can
/// register it alongside the match and profile destinations.
enum SearchTarget: Hashable {
    case players
}

/// Runs `searchUsers` against the shared debounce, so a fast typist doesn't fire
/// a request per keystroke. Cancelling the previous task cancels its sleep too,
/// which is what makes the debounce work — the old code cancelled the task but
/// fired the request immediately, so "debounced" was only ever a comment.
@MainActor
final class PeopleSearchModel: ObservableObject {
    @Published private(set) var results: [UserResult] = []
    @Published private(set) var searching = false
    /// True once a search for the current query has actually completed, so the
    /// UI can tell "nobody by that name" from "hasn't looked yet".
    @Published private(set) var searched = false

    /// The server ignores anything shorter (`/api/users` returns an empty list
    /// under two characters), so the UI says so rather than looking broken.
    static let minimumQuery = 2

    private var task: Task<Void, Never>?
    private let api = UploadAPI()

    func search(_ raw: String) {
        task?.cancel()
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= Self.minimumQuery else {
            results = []
            searching = false
            searched = false
            return
        }
        searching = true
        task = Task { [api] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let found = (try? await api.searchUsers(q)) ?? []
            guard !Task.isCancelled else { return }
            self.results = found
            self.searching = false
            self.searched = true
        }
    }
}

/// One search result: avatar, name, and a push into their profile.
struct PersonRow: View {
    let user: UserResult

    var body: some View {
        NavigationLink(value: ProfileTarget.user(id: user.id)) {
            HStack(spacing: 10) {
                Avatar(name: user.displayName, size: 32)
                Text(user.displayName).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The search field itself, shared by the inline widget and the full screen.
struct PeopleSearchField: View {
    @Binding var query: String
    var focused: FocusState<Bool>.Binding?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
            Group {
                if let focused {
                    TextField("Search players", text: $query).focused(focused)
                } else {
                    TextField("Search players", text: $query)
                }
            }
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .foregroundStyle(Theme.text)

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
    }
}

/// Debounced people search as an inline block — type a name, tap a result to
/// open their profile. Used in the feed's empty state. Mirrors the web
/// `PeopleSearch`.
struct PeopleSearch: View {
    @State private var query = ""
    @StateObject private var model = PeopleSearchModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PeopleSearchField(query: $query, focused: nil)
            ForEach(model.results) { PersonRow(user: $0) }
        }
        .onChange(of: query) { _, q in model.search(q) }
    }
}

/// People search as a screen of its own, pushed from the magnifying glass beside
/// the Home title. Everyone on Ojo is searchable by name here — the same
/// `/api/users` endpoint the participant picker uses, which matches on display
/// name, first name and last name.
struct PeopleSearchView: View {
    @State private var query = ""
    @StateObject private var model = PeopleSearchModel()
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                PeopleSearchField(query: $query, focused: $fieldFocused)
                content
            }
            .padding(16)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Find players")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: query) { _, q in model.search(q) }
        .task {
            // A beat after the push animation, or the field takes focus while the
            // screen is still sliding in and the keyboard fights the transition.
            try? await Task.sleep(for: .milliseconds(300))
            fieldFocused = true
        }
    }

    @ViewBuilder private var content: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < PeopleSearchModel.minimumQuery {
            hint(trimmed.isEmpty
                 ? "Search for anyone on Ojo by name."
                 : "Keep typing — at least \(PeopleSearchModel.minimumQuery) letters.")
        } else if model.searching && model.results.isEmpty {
            ProgressView().tint(Theme.accent)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
        } else if model.results.isEmpty && model.searched {
            hint("No players found for “\(trimmed)”.")
        } else {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(model.results) { user in
                    PersonRow(user: user)
                    if user.id != model.results.last?.id {
                        Rectangle().fill(Theme.border).frame(height: 0.5)
                    }
                }
            }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
    }
}
