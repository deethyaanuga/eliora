import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { verifyUser } from "@/lib/users";

// Read-only Google Classroom scopes so Eliora can pull the signed-in student's
// own courses, coursework, and grades. Sensitive scopes: the Classroom API must
// be enabled on the Google Cloud project and these must be added to the OAuth
// consent screen (app stays in "testing" until Google verifies it — fine for dev).
const CLASSROOM_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
].join(" ");

// Auth.js (NextAuth v5). Two ways to sign in:
//  - Google (OAuth) — auto-reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET.
//  - Email + password (Credentials) — verified against the local user store
//    in lib/users.ts. Sessions are JWT, so no database is needed.
// AUTH_SECRET signs the session. See apps/web/.env.local.example.
// The Google access token is stashed on the JWT and surfaced on the session so
// /api/grades/sync can call the Classroom API on the student's behalf. With no
// database we don't persist refresh tokens, so grade pulls are on-demand only
// (the token lives as long as the session) — background sync would need a DB.
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.authProvider = account.provider;
      }
      return token;
    },
    async session({ session, token }) {
      const s = session as typeof session & {
        accessToken?: string;
        authProvider?: string;
      };
      s.accessToken = token.accessToken as string | undefined;
      s.authProvider = token.authProvider as string | undefined;
      return s;
    },
  },
  providers: [
    Google({
      authorization: {
        params: {
          scope: CLASSROOM_SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
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
