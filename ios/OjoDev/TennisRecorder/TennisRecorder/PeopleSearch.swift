import SwiftUI

/// Debounced people search — type a name, tap a result to open their profile.
/// Mirrors the web `PeopleSearch`.
struct PeopleSearch: View {
    @State private var query = ""
    @State private var results: [UserResult] = []
    @State private var searchTask: Task<Void, Never>?

    private let api = UploadAPI()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Search players", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .foregroundStyle(Theme.text)
                .onChange(of: query) { _, q in search(q) }

            ForEach(results) { user in
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
    }

    private func search(_ q: String) {
        searchTask?.cancel()
        searchTask = Task {
            let found = (try? await api.searchUsers(q)) ?? []
            if !Task.isCancelled {
                await MainActor.run { results = found }
            }
        }
    }
}
