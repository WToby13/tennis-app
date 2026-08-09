import SwiftUI

struct LoginView: View {
    @ObservedObject var auth: AuthModel
    @State private var isSignUp = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image("OjoLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 76, height: 76)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text("Ojo Tennis")
                .font(.system(.title, design: .default).weight(.bold))
                .tracking(-0.5)

            Text(isSignUp ? "Create an account." : "Sign in to your account.")
                .font(.subheadline).foregroundStyle(.secondary)

            // Google — same provider as the web app.
            Button {
                Task { await auth.signInWithGoogle() }
            } label: {
                Label("Continue with Google", systemImage: "g.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(auth.busy)

            HStack {
                Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
                Text("OR").font(.caption2).foregroundStyle(.secondary)
                Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
            }
            .padding(.vertical, 2)

            if isSignUp {
                HStack(spacing: 10) {
                    TextField("First name", text: $auth.firstName)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.givenName)
                    TextField("Last name", text: $auth.lastName)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.familyName)
                }

                Picker("Playing hand", selection: $auth.handedness) {
                    Text("Left-handed").tag("left")
                    Text("Right-handed").tag("right")
                }
                .pickerStyle(.segmented)
            }

            // "Email", not a sample address: iOS link-detects an email-shaped
            // placeholder and renders it in system blue instead of placeholder grey.
            TextField("Email", text: $auth.email)
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
            .disabled(auth.busy || auth.email.isEmpty || auth.password.isEmpty
                      || (isSignUp && (auth.firstName.isEmpty || auth.lastName.isEmpty)))

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
