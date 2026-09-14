/**
 * FCM HTTP v1 sender.
 *
 * Authenticates as the Firebase service account: builds an RS256 JWT, trades
 * it for an OAuth access token, and posts to the v1 messages endpoint. All of
 * it via WebCrypto, because Workers have no Node crypto and no googleapis.
 *
 * Messages are sent DATA-ONLY and deliberately carry no `notification` block.
 * A notification block makes Android render the tray entry itself while the
 * app is backgrounded, which bypasses NotificationService entirely: wrong
 * channel, wrong importance, wrong colour, and a tap that never reaches
 * flutter_local_notifications. Data-only wakes the app's own background
 * handler, which renders through the same code path as a local alert.
 */

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Access tokens last an hour; minting one per 3-minute run is pure waste. */
let tokenCache = { token: null, expiresAt: 0 };

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(str) {
  return b64url(new TextEncoder().encode(str));
}

/**
 * PKCS#8 PEM to an ArrayBuffer WebCrypto will accept.
 *
 * The secret is JSON, so `private_key` arrives with two-character `\n`
 * sequences that JSON.parse turns into real newlines. If someone pasted the
 * key through an editor that expanded them first, or stripped them, this is
 * where it shows up — hence the explicit shape check in loadServiceAccount.
 */
function pemToBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * Parse and sanity-check the service account secret.
 *
 * Fails loudly with a specific message rather than letting a malformed key
 * surface later as an opaque WebCrypto DataError, which says nothing about
 * which field is wrong.
 */
export function loadServiceAccount(raw) {
  if (!raw) throw new Error("FCM_SERVICE_ACCOUNT secret is not set");

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT is not valid JSON — paste the whole file, { through }");
  }

  for (const field of ["client_email", "private_key", "project_id"]) {
    if (!sa[field]) throw new Error(`FCM_SERVICE_ACCOUNT is missing "${field}"`);
  }
  if (!sa.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new Error('FCM_SERVICE_ACCOUNT "private_key" is not a PKCS#8 PEM');
  }
  if (!sa.private_key.includes("\n")) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT "private_key" has no line breaks — the \\n escapes were stripped on paste'
    );
  }
  return sa;
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiresAt > now + 60) return tokenCache.token;

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64urlString(JSON.stringify(header))}.${b64urlString(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${body.error_description || body.error || "unknown"}`);
  }

  tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in || 3600) };
  return tokenCache.token;
}

/**
 * Send one data-only message to a topic condition.
 *
 * FCM conditions accept at most 5 topics, which is exactly the number of
 * storm levels — so an observed G3 reaches G1, G2 and G3 subscribers in a
 * single call rather than three.
 *
 * Every data value must be a string; FCM rejects numbers outright.
 */
export async function sendToCondition(sa, condition, data) {
  const token = await accessToken(sa);
  const stringified = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) stringified[k] = String(v);
  }

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          condition,
          data: stringified,
          // Storm and flare alerts are time-critical and must survive Doze.
          android: { priority: "high" },
          apns: { headers: { "apns-priority": "10" } },
        },
      }),
    }
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`FCM send failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.name || "sent";
}

/** `'storm_g1' in topics || 'storm_g2' in topics` — at most 5 terms. */
export function topicCondition(topics) {
  return topics.map((t) => `'${t}' in topics`).join(" || ");
}
