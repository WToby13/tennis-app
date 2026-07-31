import SwiftUI

struct LoginView: View {
    @ObservedObject var auth: AuthModel
    @State private var code = ""

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("🎾").font(.system(size: 64))
            Text("Tennis Review").font(.title).bold()

            if !auth.codeSent {
                Text("Sign in with your email — we'll send you a code.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                TextField("you@example.com", text: $auth.email)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Send code") { Task { await auth.sendCode() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(auth.busy || auth.email.isEmpty)
            } else {
                Text("Enter the 6-digit code sent to \(auth.email).")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                TextField("123456", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)
                Button("Verify") { Task { await auth.verify(code: code) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(auth.busy || code.isEmpty)
                Button("Use a different email") { auth.codeSent = false }
                    .font(.footnote)
            }

            if let error = auth.error {
                Text(error).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding()
    }
}
