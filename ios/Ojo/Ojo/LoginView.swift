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

            // Sign in with Apple first: Guideline 4.8 requires an equivalent
            // login option alongside Google, and Apple's is the one that lets
            // someone keep their address private. Top of the list because on
            // iOS it is also the fastest way in — one tap, no typing.
            Button {
                Task { await auth.signInWithApple() }
            } label: {
                Label("Continue with Apple", systemImage: "apple.logo")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .disabled(auth.busy)

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
                // Paired with signup_completed, this is the drop-off on the form
                // itself — the one part of the funnel neither the server nor the
                // web app can see, because iOS sign-up never touches our API.
                if isSignUp { Analytics.track(.signupStarted, props: ["from": "ios_login"]) }
            }
            .font(.footnote)

            // Guideline 1.2 wants the EULA in front of someone "before registering
            // or logging in" — both, which is why this is not inside `if isSignUp`.
            // It used to be, and the screen opens in sign-in state, so anyone who
            // signed in with an existing account never saw it at all. That is what
            // a reviewer does with a demo account, and it cost a rejection.
            Text(isSignUp
                 ? "By creating an account you agree to our [Terms](https://ojotennis.com/terms) and [Privacy Policy](https://ojotennis.com/privacy). We remove objectionable content and the accounts that post it."
                 : "By signing in you agree to our [Terms](https://ojotennis.com/terms) and [Privacy Policy](https://ojotennis.com/privacy). We remove objectionable content and the accounts that post it.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .tint(Theme.accent)
                .padding(.top, 2)

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
