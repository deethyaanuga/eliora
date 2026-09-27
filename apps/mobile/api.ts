// Where the mobile app finds the Eliora web server.
//
// "localhost" means *this device*. On a simulator that happens to be the same
// machine the dev server runs on, so it works and the problem stays hidden —
// but in Expo Go on a real phone it resolves to the handset, nothing is
// listening, and every call comes back "Sorry, I couldn't reach Eliora."
//
// The dev server's real address is already in the manifest: Expo Go had to
// reach it to load this bundle at all. So when the configured URL points at
// loopback we keep its scheme, port and path and swap in that host. A configured
// URL that names a real host is a deliberate choice (a deployed API) and is left
// exactly as written.
import Constants from "expo-constants";

const CONFIGURED =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined)?.trim() ||
  "http://localhost:3000";

const URL_PARTS = /^(https?:\/\/)([^/:?#]+)(:\d+)?(.*)$/i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i;
// Only a bare IPv4 is borrowed. A LAN dev server is always an IP; a hostname
// there means a tunnel (foo.exp.direct), where the web app isn't served on the
// same host and guessing would just swap one wrong URL for another.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function devServerHost(): string | undefined {
  const uri =
    Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  // "192.168.1.7:8081" — sometimes with a path or query hung off the end.
  const host = uri?.split(/[/?#]/)[0]?.split(":")[0]?.trim();
  return host && IPV4.test(host) ? host : undefined;
}

function resolve(): string {
  const parts = CONFIGURED.match(URL_PARTS);
  if (!parts) return CONFIGURED;

  const [, scheme, host, port = "", rest = ""] = parts;
  if (!LOOPBACK.test(host)) return CONFIGURED;

  const lan = devServerHost();
  return lan ? `${scheme}${lan}${port}${rest}` : CONFIGURED;
}

export const API_BASE_URL: string = resolve();
