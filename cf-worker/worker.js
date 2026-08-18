/**
 * ============================================================
 *  STUDIO COUVERTURE AI — Cloudflare Worker (backend sans carte)
 * ============================================================
 * Remplace les Firebase Cloud Functions (qui exigent le plan Blaze / une carte).
 * Zéro dépendance npm — copie-colle direct dans l'éditeur Cloudflare Workers.
 *
 * Variables d'environnement à configurer (Settings > Variables and Secrets) :
 *   FIREBASE_PROJECT_ID        (ex: studio-couverture-ai)
 *   FIREBASE_SERVICE_ACCOUNT   (JSON complet de la clé de compte de service, en Secret)
 *   GEMINI_API_KEY             (Secret)
 *   STRIPE_SECRET_KEY          (Secret, optionnel)
 *   STRIPE_WEBHOOK_SECRET      (Secret, optionnel)
 *   NOWPAYMENTS_API_KEY        (Secret, optionnel)
 *   NOWPAYMENTS_IPN_SECRET     (Secret, optionnel)
 *   ALLOWED_ORIGIN             (ex: https://leblancroben-afk.github.io)
 *
 * Comment obtenir FIREBASE_SERVICE_ACCOUNT :
 *   Firebase Console > Paramètres du projet > Comptes de service >
 *   "Générer une nouvelle clé privée" (télécharge un fichier .json)
 *   Collez tout le contenu du fichier tel quel dans la variable secrète.
 * ============================================================
 */

const CREDIT_PACKS = {
  pack_10: { credits: 10, amountCents: 500, label: "10 crédits IA" },
  pack_50: { credits: 50, amountCents: 2000, label: "50 crédits IA" },
  pack_150: { credits: 150, amountCents: 5000, label: "150 crédits IA" },
};

// ============================================================
//  UTILITAIRES CRYPTO (Web Crypto natif, pas de librairie)
// ============================================================

function base64urlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const raw = atob(padded);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64url(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64url(text) {
  return uint8ArrayToBase64url(new TextEncoder().encode(text));
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return base64urlToUint8Array(b64.replace(/\+/g, "-").replace(/\//g, "_")).buffer;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Vérifie un ID Token Firebase (émis après connexion anonyme côté client)
async function verifyFirebaseIdToken(idToken, projectId) {
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Token malformé");

  const header = JSON.parse(new TextDecoder().decode(base64urlToUint8Array(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToUint8Array(payloadB64)));

  // Récupère les clés publiques Google (format JWK, mis en cache 1h par Cloudflare)
  const jwkRes = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com", {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  const { keys } = await jwkRes.json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Clé publique Firebase introuvable");

  const publicKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedData);
  if (!valid) throw new Error("Signature du token invalide");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("Token expiré");
  if (payload.aud !== projectId) throw new Error(`Audience du token incorrecte (attendu: "${projectId}", reçu: "${payload.aud}")`);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Émetteur du token incorrect");

  return payload.sub; // uid Firebase
}

// Obtient un access_token OAuth2 Google via le compte de service (pour appeler Firestore en admin)
async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedJwt = `${textToBase64url(JSON.stringify(header))}.${textToBase64url(JSON.stringify(claims))}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsignedJwt));
  const jwt = `${unsignedJwt}.${uint8ArrayToBase64url(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error("Échec d'obtention du token Google: " + JSON.stringify(tokenJson));
  return tokenJson.access_token;
}

// ============================================================
//  FIRESTORE REST (lecture/écriture admin via access_token)
// ============================================================

async function getUserCredits(projectId, accessToken, uid) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 404) return 0;
  const doc = await res.json();
  return parseInt(doc.fields?.credits?.integerValue || "0", 10);
}

async function incrementUserCredits(projectId, accessToken, uid, delta) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `projects/${projectId}/databases/(default)/documents/users/${uid}`,
          fieldTransforms: [{ fieldPath: "credits", increment: { integerValue: String(delta) } }],
        },
      }],
    }),
  });
}

async function isOrderProcessed(projectId, accessToken, orderId) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/processed_orders/${orderId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.status === 200;
}

async function markOrderProcessed(projectId, accessToken, orderId) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/processed_orders/${orderId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { processedAt: { timestampValue: new Date().toISOString() } } }),
    }
  );
}

// ============================================================
//  HELPERS RÉPONSE / CORS
// ============================================================

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace("Bearer ", "");
  if (!idToken) throw new Error("Non authentifié");
  return await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
}

// ============================================================
//  ROUTES
// ============================================================

async function handleGenerateImage(request, env) {
  const uid = await requireAuth(request, env);
  const { prompt } = await request.json();

  const accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  const credits = await getUserCredits(env.FIREBASE_PROJECT_ID, accessToken, uid);
  if (credits < 1) return json({ error: "Crédits insuffisants." }, 402, env);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${env.GEMINI_API_KEY}`;
  const geminiRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: `${prompt}, high quality book cover illustration` }],
      parameters: { sampleCount: 1 },
    }),
  });
  const geminiJson = await geminiRes.json();
  if (!geminiJson.predictions?.[0]?.bytesBase64Encoded) {
    return json({ error: "Échec Gemini: " + JSON.stringify(geminiJson).slice(0, 300) }, 500, env);
  }

  await incrementUserCredits(env.FIREBASE_PROJECT_ID, accessToken, uid, -1);
  return json({ imageBase64: geminiJson.predictions[0].bytesBase64Encoded }, 200, env);
}

async function handleCreateCheckoutSession(request, env) {
  const uid = await requireAuth(request, env);
  const { packId, successUrl, cancelUrl } = await request.json();
  const pack = CREDIT_PACKS[packId];
  if (!pack) return json({ error: "Pack inconnu." }, 400, env);

  const body = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": pack.label,
    "line_items[0][price_data][unit_amount]": String(pack.amountCents),
    "line_items[0][quantity]": "1",
    "metadata[uid]": uid,
    "metadata[packId]": packId,
    success_url: successUrl || "https://example.com/success",
    cancel_url: cancelUrl || "https://example.com/cancel",
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const session = await stripeRes.json();
  if (!session.url) return json({ error: "Échec de création de la session Stripe.", details: session }, 500, env);
  return json({ url: session.url }, 200, env);
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature") || "";
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const signedPayload = `${parts.t}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computedSig = bufferToHex(sigBuffer);

  if (computedSig !== parts.v1) return new Response("Invalid signature", { status: 401 });

  const event = JSON.parse(rawBody);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { uid, packId } = session.metadata || {};
    const pack = CREDIT_PACKS[packId];
    if (uid && pack) {
      const accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
      const orderId = `stripe_${session.id}`;
      if (!(await isOrderProcessed(env.FIREBASE_PROJECT_ID, accessToken, orderId))) {
        await incrementUserCredits(env.FIREBASE_PROJECT_ID, accessToken, uid, pack.credits);
        await markOrderProcessed(env.FIREBASE_PROJECT_ID, accessToken, orderId);
      }
    }
  }
  return new Response("ok", { status: 200 });
}

async function handleCreateCryptoInvoice(request, env) {
  const uid = await requireAuth(request, env);
  const { packId, successUrl } = await request.json();
  const pack = CREDIT_PACKS[packId];
  if (!pack) return json({ error: "Pack inconnu." }, 400, env);

  const orderId = `${uid}__${packId}__${Date.now()}`;
  const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: { "x-api-key": env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      price_amount: pack.amountCents / 100,
      price_currency: "usd",
      order_id: orderId,
      order_description: pack.label,
      ipn_callback_url: env.NOWPAYMENTS_IPN_URL,
      success_url: successUrl || "https://example.com/success",
    }),
  });
  const invoice = await npRes.json();
  if (!invoice.invoice_url) return json({ error: "Échec de création de la facture.", details: invoice }, 500, env);
  return json({ url: invoice.invoice_url }, 200, env);
}

function sortObjectKeys(obj) {
  return Object.keys(obj).sort().reduce((result, key) => {
    result[key] = obj[key] && typeof obj[key] === "object" ? sortObjectKeys(obj[key]) : obj[key];
    return result;
  }, {});
}

async function handleNowPaymentsWebhook(request, env) {
  const bodyText = await request.text();
  const body = JSON.parse(bodyText);
  const receivedSig = request.headers.get("x-nowpayments-sig") || "";

  const sortedJson = JSON.stringify(sortObjectKeys(body));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.NOWPAYMENTS_IPN_SECRET), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sortedJson));
  const computedSig = bufferToHex(sigBuffer);

  if (computedSig !== receivedSig) return new Response("Invalid signature", { status: 401 });

  if (body.payment_status === "finished" || body.payment_status === "confirmed") {
    const [uid, packId] = (body.order_id || "").split("__");
    const pack = CREDIT_PACKS[packId];
    if (uid && pack) {
      const accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
      const orderId = `crypto_${body.order_id}`;
      if (!(await isOrderProcessed(env.FIREBASE_PROJECT_ID, accessToken, orderId))) {
        await incrementUserCredits(env.FIREBASE_PROJECT_ID, accessToken, uid, pack.credits);
        await markOrderProcessed(env.FIREBASE_PROJECT_ID, accessToken, orderId);
      }
    }
  }
  return new Response("ok", { status: 200 });
}

// ============================================================
//  ROUTEUR PRINCIPAL
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    env = { ...env, FIREBASE_PROJECT_ID: (env.FIREBASE_PROJECT_ID || "").trim() };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      switch (url.pathname) {
        case "/generate-image":
          return await handleGenerateImage(request, env);
        case "/create-checkout-session":
          return await handleCreateCheckoutSession(request, env);
        case "/stripe-webhook":
          return await handleStripeWebhook(request, env);
        case "/create-crypto-invoice":
          return await handleCreateCryptoInvoice(request, env);
        case "/nowpayments-webhook":
          return await handleNowPaymentsWebhook(request, env);
        default:
          return json({ error: "Route inconnue." }, 404, env);
      }
    } catch (err) {
      return json({ error: err.message || "Erreur serveur." }, 500, env);
    }
  },
};
