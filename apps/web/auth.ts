import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { verifyUser } from "@/lib/users";

// Auth.js (NextAuth v5). Two ways to sign in:
//  - Google (OAuth) — auto-reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET.
//  - Email + password (Credentials) — verified against the local user store
//    in lib/users.ts. Sessions are JWT, so no database is needed.
// AUTH_SECRET signs the session. See apps/web/.env.local.example.
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/" },
  providers: [
    Google,
    Credentials({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        const email = typeof creds?.email === "string" ? creds.email : "";
        const password =
          typeof creds?.password === "string" ? creds.password : "";
        if (!email || !password) return null;
        return await verifyUser(email, password);
      },
    }),
  ],
});
