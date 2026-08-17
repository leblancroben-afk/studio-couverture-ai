const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

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
