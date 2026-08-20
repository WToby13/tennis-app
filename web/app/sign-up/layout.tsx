import type { Metadata } from "next";

// The page itself is a client component, so its metadata lives here.
export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Create a free Ojo Tennis account to record your matches, review every point in slow motion and share them with the people you played.",
  alternates: { canonical: "/sign-up" },
};

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
