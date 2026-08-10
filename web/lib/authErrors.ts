/**
 * Supabase's auth errors are written for developers. These are for the person
 * who just failed to get into their account.
 */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) {
    return "That email and password don't match an account.";
  }
  if (m.includes("email not confirmed")) {
    return "Check your inbox and confirm your email address first.";
  }
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "There's already an account with that email — try signing in instead.";
  }
  if (m.includes("password should be") || m.includes("weak password")) {
    return "Pick a longer password — at least 6 characters.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts — wait a minute and try again.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return message;
}
