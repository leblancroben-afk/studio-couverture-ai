const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const Stripe = require("stripe");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// Clé secrète Stripe (jamais exposée au client) — voir functions/.env.example
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Packs de crédits en vente. Modifiable librement selon votre pricing.
const CREDIT_PACKS = {
  pack_10: { credits: 10, amountCents: 500, label: "10 crédits IA" },
  pack_50: { credits: 50, amountCents: 2000, label: "50 crédits IA" },
  pack_150: { credits: 150, amountCents: 5000, label: "150 crédits IA" },
};

exports.generateGeminiImage = functions.https.onCall(async (data, context) => {
  // 1. Vérification Authentification
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Utilisateur non connecté.");
  }

  const uid = context.auth.uid;
  const prompt = data.prompt;

  // 2. Vérification & Décompte des Crédits dans Firestore
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists || userDoc.data().credits < 1) {
    throw new functions.https.HttpsError("resource-exhausted", "Crédits insuffisants.");
  }

  // 3. Appel Sécurisé de l'API Gemini / Imagen (Clé API masquée côté serveur, jamais exposée au client)
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new functions.https.HttpsError("failed-precondition", "GEMINI_API_KEY manquante. Voir functions/.env.example.");
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${geminiApiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: `${prompt}, high quality book cover illustration` }],
        parameters: { sampleCount: 1 }
      })
    });

    const json = await response.json();

    // Décompter 1 crédit après succès
    await userRef.update({
      credits: admin.firestore.FieldValue.increment(-1)
    });

    return { imageBase64: json.predictions[0].bytesBase64Encoded };
  } catch (error) {
    throw new functions.https.HttpsError("internal", "Échec de la génération IA.");
  }
});

// ============================================================
//  PAIEMENT STRIPE — Achat de packs de crédits
// ============================================================

// Crée une session Stripe Checkout pour un pack de crédits donné.
// Appelée depuis le client (bouton "Acheter des crédits").
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Utilisateur non connecté.");
  }
  if (!stripe) {
    throw new functions.https.HttpsError("failed-precondition", "STRIPE_SECRET_KEY manquante. Voir functions/.env.example.");
  }

  const packId = data.packId;
  const pack = CREDIT_PACKS[packId];
  if (!pack) {
    throw new functions.https.HttpsError("invalid-argument", "Pack de crédits inconnu.");
  }

  const uid = context.auth.uid;
  const successUrl = data.successUrl || "https://example.com/success";
  const cancelUrl = data.cancelUrl || "https://example.com/cancel";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: pack.label },
        unit_amount: pack.amountCents,
      },
      quantity: 1,
    }],
    // On stocke l'uid et le pack acheté dans les metadata pour les retrouver dans le webhook
    metadata: { uid, packId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { url: session.url };
});

// Webhook Stripe : appelé par Stripe (pas par le client) après un paiement réussi.
// Crédite le compte Firestore de l'utilisateur. URL à configurer dans le Dashboard Stripe.
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (!stripe) {
    res.status(500).send("STRIPE_SECRET_KEY manquante.");
    return;
  }
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Signature Stripe invalide :", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.metadata && session.metadata.uid;
    const packId = session.metadata && session.metadata.packId;
    const pack = CREDIT_PACKS[packId];

    if (uid && pack) {
      const userRef = db.collection("users").doc(uid);
      await userRef.set({
        credits: admin.firestore.FieldValue.increment(pack.credits)
      }, { merge: true });
      console.log(`Crédité ${pack.credits} crédits à l'utilisateur ${uid} (pack ${packId})`);
    }
  }

  res.status(200).send("ok");
});

// ============================================================
//  PAIEMENT CRYPTO (NOWPayments) — Alternative à Stripe
// ============================================================

// Crée une facture NOWPayments pour un pack de crédits (BTC, ETH, USDT, etc.)
exports.createCryptoInvoice = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Utilisateur non connecté.");
  }
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new functions.https.HttpsError("failed-precondition", "NOWPAYMENTS_API_KEY manquante. Voir functions/.env.example.");
  }

  const packId = data.packId;
  const pack = CREDIT_PACKS[packId];
  if (!pack) {
    throw new functions.https.HttpsError("invalid-argument", "Pack de crédits inconnu.");
  }

  const uid = context.auth.uid;
  const successUrl = data.successUrl || "https://example.com/success";
  // On encode uid + packId dans order_id pour les retrouver dans le webhook IPN
  // (NOWPayments n'a pas de champ "metadata" comme Stripe)
  const orderId = `${uid}__${packId}__${Date.now()}`;

  const response = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: pack.amountCents / 100,
      price_currency: "usd",
      order_id: orderId,
      order_description: pack.label,
      ipn_callback_url: process.env.NOWPAYMENTS_IPN_URL, // URL déployée de nowPaymentsWebhook
      success_url: successUrl,
    }),
  });

  const json = await response.json();
  if (!json.invoice_url) {
    console.error("Réponse NOWPayments inattendue :", json);
    throw new functions.https.HttpsError("internal", "Échec de la création de la facture crypto.");
  }

  return { url: json.invoice_url };
});

// Webhook IPN NOWPayments : vérifie la signature HMAC-SHA512 et crédite l'utilisateur
// une fois le paiement confirmé. URL à renseigner dans le Dashboard NOWPayments
// (Store Settings > Instant Payment Notifications) ET dans NOWPAYMENTS_IPN_URL (.env).
exports.nowPaymentsWebhook = functions.https.onRequest(async (req, res) => {
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    res.status(500).send("NOWPAYMENTS_IPN_SECRET manquante.");
    return;
  }

  // Vérification de la signature (tri des clés + HMAC SHA-512, cf. doc NOWPayments)
  function sortObject(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
      result[key] = (obj[key] && typeof obj[key] === "object") ? sortObject(obj[key]) : obj[key];
      return result;
    }, {});
  }

  const receivedSig = req.headers["x-nowpayments-sig"];
  const sortedBody = sortObject(req.body);
  const hmac = crypto.createHmac("sha512", ipnSecret);
  hmac.update(JSON.stringify(sortedBody));
  const computedSig = hmac.digest("hex");

  if (receivedSig !== computedSig) {
    console.error("Signature NOWPayments invalide.");
    res.status(401).send("Invalid signature");
    return;
  }

  const paymentStatus = req.body.payment_status;
  const orderId = req.body.order_id || "";

  // On ne crédite que sur confirmation définitive du paiement
  if (paymentStatus === "finished" || paymentStatus === "confirmed") {
    const [uid, packId] = orderId.split("__");
    const pack = CREDIT_PACKS[packId];

    if (uid && pack) {
      // Idempotence : on vérifie qu'on n'a pas déjà traité cette commande
      const orderRef = db.collection("processed_crypto_orders").doc(orderId);
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) {
        await db.collection("users").doc(uid).set({
          credits: admin.firestore.FieldValue.increment(pack.credits)
        }, { merge: true });
        await orderRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`[Crypto] Crédité ${pack.credits} crédits à ${uid} (commande ${orderId})`);
      }
    }
  }

  res.status(200).send("ok");
});
