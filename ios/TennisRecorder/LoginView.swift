import SwiftUI

struct LoginView: View {
    @ObservedObject var auth: AuthModel
    @State private var isSignUp = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("🎾").font(.system(size: 64))
            Text("Tennis Review").font(.title).bold()

            Text(isSignUp ? "Create an account." : "Sign in to your account.")
                .font(.subheadline).foregroundStyle(.secondary)

            TextField("you@example.com", text: $auth.email)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("Password", text: $auth.password)
                .textFieldStyle(.roundedBorder)

            Button(isSignUp ? "Create account" : "Sign in") {
                Task { isSignUp ? await auth.signUp() : await auth.signIn() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(auth.busy || auth.email.isEmpty || auth.password.isEmpty)

            Button(isSignUp ? "Have an account? Sign in" : "No account? Create one") {
                isSignUp.toggle()
                auth.error = nil
                auth.notice = nil
            }
            .font(.footnote)

            if let notice = auth.notice {
                Text(notice).font(.caption).foregroundStyle(.green).multilineTextAlignment(.center)
            }
            if let error = auth.error {
                Text(error).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding()
    }
}
