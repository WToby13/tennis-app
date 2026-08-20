import SwiftUI

/// Account settings: the legal documents, the blocked list, sign out, and
/// deleting the account.
///
/// Deletion is the reason this screen exists. App Store Review Guideline
/// 5.1.1(v) requires an app that creates accounts to let you delete yours from
/// inside the app — not by emailing support, and not by merely deactivating —
/// and reviewers look for it under an obvious "Settings" or "Account" heading,
/// which is why it isn't buried on the profile itself.
struct SettingsView: View {
    @ObservedObject var auth: AuthModel

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var deleteError: String?

    private let api = UploadAPI()

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if let email = auth.accountEmail {
                        LabeledContent("Signed in as", value: email)
                    }
                    NavigationLink { BlockedAccountsView() } label: {
                        Label("Blocked accounts", systemImage: "hand.raised")
                    }
                }

                Section("Legal") {
                    Link(destination: Config.apiBaseURL.appendingPathComponent("privacy")) {
                        Label("Privacy Policy", systemImage: "lock.shield")
                    }
                    Link(destination: Config.apiBaseURL.appendingPathComponent("terms")) {
                        Label("Terms of Service", systemImage: "doc.text")
                    }
                    Link(destination: URL(string: "mailto:support@ojotennis.com")!) {
                        Label("Contact support", systemImage: "envelope")
                    }
                }

                Section {
                    Button("Sign out") {
                        Task {
                            await auth.signOut()
                            dismiss()
                        }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        if deleting {
                            HStack { ProgressView(); Text("Deleting…") }
                        } else {
                            Text("Delete account")
                        }
                    }
                    .disabled(deleting)
                    if let deleteError {
                        Text(deleteError).font(.footnote).foregroundStyle(Theme.danger)
                    }
                } footer: {
                    Text("Deletes your account, every match you've recorded and the video files behind them. This can't be undone.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete your account?",
                isPresented: $confirmingDelete,
                titleVisibility: .visible
            ) {
                Button("Delete everything", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your matches and their video files are deleted permanently. This can't be undone.")
            }
        }
    }

    private func deleteAccount() {
        deleting = true
        deleteError = nil
        Task {
            defer { deleting = false }
            do {
                try await api.deleteAccount()
                // The account is gone server-side; clear the local session so the
                // app falls back to the login screen instead of holding a token
                // for a user that no longer exists.
                await auth.signOut()
                dismiss()
            } catch {
                deleteError = "Couldn't delete your account. Try again, or email support@ojotennis.com."
            }
        }
    }
}
