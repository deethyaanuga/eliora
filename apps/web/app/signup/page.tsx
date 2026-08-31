"use client";

// /signup is the same landing surface as "/", just opened on the Sign up tab.
// The whole split-screen — form, scrolling demo panel and styles — lives in
// app/ui/auth-landing.tsx so both entry points stay in sync.

import AuthLanding from "@/app/ui/auth-landing";

export default function SignUpPage() {
  return <AuthLanding initialMode="signup" showBack />;
}
