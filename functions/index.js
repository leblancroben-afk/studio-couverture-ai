const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const Stripe = require("stripe");

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
