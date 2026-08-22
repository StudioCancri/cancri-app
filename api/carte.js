/* ============================================================
   API CANCRI — /api/carte  (Vercel serverless)
   Une seule porte d'entrée, 4 actions :
   - creer   : nouvelle carte (tampon de bienvenue = 1)
   - etat    : lire l'état de la carte
   - tap     : +1 tampon (cooldown 15 s, 3/jour max, vérif NFC SDM)
   - valider : le staff offre la récompense (code), carte repart à 1

   Variables d'environnement à définir sur Vercel :
   SUPABASE_URL     = https://xxxx.supabase.co
   SUPABASE_SECRET  = sb_secret_...   (jamais dans une page web !)
   NFC_CLE_SDM      = 32 caractères hex (clé AES 1 des puces 424)
   ============================================================ */

const { randomUUID } = require("crypto");
const crypto = require("crypto");
const http2 = require("http2");

function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

/* Envoi de la notif push Apple (méthode certificat) — local, pas d'import croisé */
async function envoyerPush(jetonCarte) {
  try {
    const appareils = await sb("appareils?jeton=eq." + encodeURIComponent(jetonCarte) + "&select=push_token");
    if (!appareils || !appareils.length) { console.log("push: aucun appareil"); return; }
    const cert = certDepuisEnv("PASS_CERT");
    const key = certDepuisEnv("PASS_KEY");
    if (!cert || !key) { console.log("push: certificats manquants"); return; }
    const passphrase = process.env.PASS_KEY_PASSPHRASE || undefined;
    const topic = process.env.PASS_TYPE_ID;

    for (const a of appareils) {
      await new Promise((resolve) => {
        let client;
        try {
          client = http2.connect("https://api.push.apple.com:443", { cert: cert, key: key, passphrase: passphrase });
        } catch (e) { console.log("push: connect err", e.message); return resolve(); }
        client.on("error", (e) => { console.log("push: client err", e.message); try { client.close(); } catch (x) {} resolve(); });
        const req = client.request({
          ":method": "POST",
          ":path": "/3/device/" + a.push_token,
          "apns-topic": topic,
          "apns-push-type": "background",
          "apns-priority": "5",
        });
        let status = "";
        req.on("response", (h) => { status = h[":status"]; });
        req.on("data", () => {});
        req.on("end", () => { console.log("push: envoyé, statut Apple", status); try { client.close(); } catch (x) {} resolve(); });
        req.on("error", (e) => { console.log("push: req err", e.message); try { client.close(); } catch (x) {} resolve(); });
        req.write(JSON.stringify({}));
        req.end();
      });
    }
  } catch (e) {
    console.log("push: erreur globale", e.message);
  }
}

/* on nettoie l'URL : slash final, /rest/v1 en trop, espaces… */
function nettoyerUrl(u) {
  return (u || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/, "")
    .replace(/\/+$/, "");
}

const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();
const CLE_SDM = (process.env.NFC_CLE_SDM || "").trim();

const COOLDOWN_S = 15;
const TAPS_MAX_JOUR = 3;
const TAMPON_DEPART = 1;
/* jusqu'à combien de taps en arrière on accepte un compteur (file d'attente au comptoir) */
const FENETRE_COMPTEUR = 50;

/* ---------- petit client Supabase (API REST, zéro dépendance) ---------- */
async function sb(chemin, options) {
  options = options || {};
  const headers = {
    apikey: SECRET,
    Authorization: "Bearer " + SECRET,
    "Content-Type": "application/json",
  };
  if (options.method === "POST" || options.method === "PATCH") {
    headers["Prefer"] = "return=representation";
  }
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) {
    const err = new Error("Supabase " + r.status + " : " + (await r.text()));
    err.statut = r.status;
    throw err;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ============================================================
   BLOC ANTI-TRICHE NFC (SUN / SDM des puces NTAG 424 DNA)
   La puce ajoute à l'URL :
     p = PICCData chiffré (32 hex) → contient l'UID + un compteur
     m = CMAC (16 hex)             → la signature
   On déchiffre, on recalcule la signature, et on refuse tout
   ce qui n'a pas été produit par une vraie puce à cet instant.
   ============================================================ */

function aesBloc(cle, bloc) {
  const c = crypto.createCipheriv("aes-128-ecb", cle, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(bloc), c.final()]);
}

function ouExclusif(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function decalerGauche(buf) {
  const out = Buffer.alloc(buf.length);
  let retenue = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    out[i] = ((buf[i] << 1) & 0xff) | retenue;
    retenue = buf[i] & 0x80 ? 1 : 0;
  }
  return out;
}

/* AES-CMAC (RFC 4493) — implémenté à la main, aucune dépendance npm */
function aesCmac(cle, message) {
  const L = aesBloc(cle, Buffer.alloc(16));
  const K1 = decalerGauche(L);
  if (L[0] & 0x80) K1[15] ^= 0x87;
  const K2 = decalerGauche(K1);
  if (K1[0] & 0x80) K2[15] ^= 0x87;

  let dernier;
  const blocs = [];
  if (message.length === 0) {
    const pad = Buffer.alloc(16);
    pad[0] = 0x80;
    dernier = ouExclusif(pad, K2);
  } else {
    const n = Math.ceil(message.length / 16);
    for (let i = 0; i < n - 1; i++) blocs.push(message.subarray(i * 16, i * 16 + 16));
    const fin = message.subarray((n - 1) * 16);
    if (fin.length === 16) {
      dernier = ouExclusif(fin, K1);
    } else {
      const pad = Buffer.alloc(16);
      fin.copy(pad, 0);
      pad[fin.length] = 0x80;
      dernier = ouExclusif(pad, K2);
    }
  }

  let X = Buffer.alloc(16);
  for (const b of blocs) X = aesBloc(cle, ouExclusif(X, b));
  return aesBloc(cle, ouExclusif(X, dernier));
}

function verifierSdm(pHex, mHex) {
  if (!/^[0-9a-fA-F]{32}$/.test(CLE_SDM)) return { ok: false, raison: "nfc_cle_absente" };
  if (!/^[0-9a-fA-F]{32}$/.test(pHex || "")) return { ok: false, raison: "nfc_picc_invalide" };
  if (!/^[0-9a-fA-F]{16}$/.test(mHex || "")) return { ok: false, raison: "nfc_cmac_invalide" };

  const cle = Buffer.from(CLE_SDM, "hex");

  /* 1. déchiffrement du PICCData (AES-128-CBC, IV à zéro, un seul bloc) */
  const dechiffreur = crypto.createDecipheriv("aes-128-cbc", cle, Buffer.alloc(16));
  dechiffreur.setAutoPadding(false);
  const clair = Buffer.concat([
    dechiffreur.update(Buffer.from(pHex, "hex")),
    dechiffreur.final(),
  ]);

  /* octet de tête : 0xC7 = UID 7 octets présent + compteur présent */
  if (clair[0] !== 0xc7) return { ok: false, raison: "nfc_illisible" };

  const uid = clair.subarray(1, 8).toString("hex").toUpperCase();
  const compteur = clair[8] | (clair[9] << 8) | (clair[10] << 16);

  /* 2. clé de session puis signature attendue (message vide : pas de file data mirroring) */
  const sv2 = Buffer.concat([
    Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]),
    clair.subarray(1, 8),
    clair.subarray(8, 11),
  ]);
  const cleSession = aesCmac(cle, sv2);
  const macComplet = aesCmac(cleSession, Buffer.alloc(0));

  const attendu = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) attendu[i] = macComplet[i * 2 + 1];

  const recu = Buffer.from(mHex, "hex");
  if (!crypto.timingSafeEqual(attendu, recu)) return { ok: false, raison: "nfc_signature" };

  return { ok: true, uid: uid, compteur: compteur };
}

/* la puce est-elle bien celle de ce commerce, et ce compteur est-il neuf ? */
async function consommerTapNfc(uid, compteur, commerce) {
  const puces = await sb("nfc_puces?uid=eq." + encodeURIComponent(uid) + "&select=*");
  const puce = puces && puces[0] ? puces[0] : null;
  if (!puce) return { ok: false, raison: "nfc_puce_inconnue" };
  if (puce.active === false) return { ok: false, raison: "nfc_puce_desactivee" };
  if (puce.commerce_id !== commerce.id) return { ok: false, raison: "nfc_mauvais_commerce" };

  const derniers = await sb(
    "nfc_taps?uid=eq." + encodeURIComponent(uid) + "&select=compteur&order=compteur.desc&limit=1"
  );
  const max = derniers && derniers[0] ? derniers[0].compteur : -1;
  if (compteur < max - FENETRE_COMPTEUR) return { ok: false, raison: "nfc_compteur_ancien" };

  try {
    await sb("nfc_taps", { method: "POST", body: { uid: uid, compteur: compteur } });
  } catch (e) {
    if (e.statut === 409) return { ok: false, raison: "nfc_rejeu" };
    throw e;
  }
  return { ok: true };
}

/* ---------- helpers ---------- */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

function tapsDuJour(carte) {
  return carte.jour_reference === aujourdhui() ? carte.taps_aujourdhui : 0;
}

function etat(carte, commerce, extra) {
  const dernier = carte.dernier_tap ? new Date(carte.dernier_tap).getTime() : 0;
  const cooldown = Math.max(
    0,
    COOLDOWN_S - Math.floor((Date.now() - dernier) / 1000)
  );
  const base = {
    ok: true,
    prenom: carte.prenom || null,
    tampons: carte.tampons,
    objectif: commerce.objectif,
    unite: commerce.unite,
    recompense: commerce.recompense,
    commerce: commerce.nom,
    pleine: carte.tampons >= commerce.objectif,
    cooldown: cooldown,
    taps_aujourdhui: tapsDuJour(carte),
    taps_max: TAPS_MAX_JOUR,
  };
  return Object.assign(base, extra || {});
}

async function commerceParSlug(slug) {
  const rows = await sb(
    "commerces?slug=eq." + encodeURIComponent(slug) + "&select=*"
  );
  return rows && rows[0] ? rows[0] : null;
}

async function carteParJeton(jeton) {
  const rows = await sb(
    "cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*"
  );
  return rows && rows[0] ? rows[0] : null;
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, info: "API Cancri en ligne ✦" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const action = body.action;

    /* ----- CREER : nouvelle carte, tampon de bienvenue ----- */
    if (action === "creer") {
      const commerce = await commerceParSlug(body.commerce || "");
      if (!commerce) {
        return res.status(200).json({ ok: false, raison: "commerce_inconnu" });
      }

      /* si le commerce est passé en NFC obligatoire, la création aussi doit être prouvée */
      if (commerce.nfc_requis === true) {
        const v = verifierSdm(body.p, body.m);
        if (!v.ok) return res.status(200).json({ ok: false, raison: v.raison });
        const c = await consommerTapNfc(v.uid, v.compteur, commerce);
        if (!c.ok) return res.status(200).json({ ok: false, raison: c.raison });
      }

      const prenom = (body.prenom || "").toString().trim().slice(0, 20) || null;
      const nom = (body.nom || "").toString().trim().slice(0, 30) || null;
      const brut = (body.email || "").toString().trim().slice(0, 80);
      const email = brut && brut.indexOf("@") > 0 ? brut : null;
      const consentement = body.consentement === true && !!email;
      const jeton = randomUUID();
      const inseres = await sb("cartes", {
        method: "POST",
        body: {
          commerce_id: commerce.id,
          prenom: prenom,
          nom: nom,
          email: email,
          consentement: consentement,
          tampons: TAMPON_DEPART,
          jeton: jeton,
          dernier_tap: new Date().toISOString(),
          taps_aujourdhui: 0,
          jour_reference: aujourdhui(),
        },
      });
      const carte = inseres[0];
      await sb("taps", {
        method: "POST",
        body: { carte_id: carte.id, valeur: TAMPON_DEPART },
      });
      return res
        .status(200)
        .json(etat(carte, commerce, { jeton: jeton, bienvenue: true }));
    }

    /* ----- toutes les autres actions demandent un jeton ----- */
    const carte = await carteParJeton(body.jeton || "");
    if (!carte) {
      return res.status(200).json({ ok: false, raison: "carte_inconnue" });
    }
    const rows = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
    const commerce = rows[0];

    /* ----- ETAT ----- */
    if (action === "etat") {
      return res.status(200).json(etat(carte, commerce));
    }

    /* ----- TAP : +1 tampon ----- */
    if (action === "tap") {
      /* --- porte d'entrée anti-triche : une vraie puce, un tap jamais rejoué --- */
      if (commerce.nfc_requis === true) {
        const v = verifierSdm(body.p, body.m);
        if (!v.ok) {
          return res
            .status(200)
            .json(etat(carte, commerce, { ok: false, raison: v.raison }));
        }
        const c = await consommerTapNfc(v.uid, v.compteur, commerce);
        if (!c.ok) {
          return res
            .status(200)
            .json(etat(carte, commerce, { ok: false, raison: c.raison }));
        }
      }

      if (carte.tampons >= commerce.objectif) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "pleine" }));
      }
      const dernier = carte.dernier_tap
        ? new Date(carte.dernier_tap).getTime()
        : 0;
      const ecart = Math.floor((Date.now() - dernier) / 1000);
      if (dernier && ecart < COOLDOWN_S) {
        return res.status(200).json(
          etat(carte, commerce, {
            ok: false,
            raison: "cooldown",
            secondes: COOLDOWN_S - ecart,
          })
        );
      }
      if (tapsDuJour(carte) >= TAPS_MAX_JOUR) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "limite" }));
      }

      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: {
          tampons: Math.min(carte.tampons + 1, commerce.objectif),
          dernier_tap: new Date().toISOString(),
          taps_aujourdhui: tapsDuJour(carte) + 1,
          jour_reference: aujourdhui(),
        },
      });
      await sb("taps", {
        method: "POST",
        body: { carte_id: carte.id, valeur: 1 },
      });
      /* mise à jour du pass Wallet (silencieux, on n'attend pas) */
      if (envoyerPush) { try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); } }
      return res
        .status(200)
        .json(etat(maj[0], commerce, { gagne: 1 }));
    }

    /* ----- VALIDER : le staff offre la récompense ----- */
    if (action === "valider") {
      if ((body.code || "") !== commerce.code_staff) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "code" }));
      }
      if (carte.tampons < commerce.objectif) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "pas_pleine" }));
      }
      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: {
          tampons: TAMPON_DEPART,
          dernier_tap: new Date().toISOString(),
        },
      });
      if (envoyerPush) { try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); } }
      return res
        .status(200)
        .json(etat(maj[0], commerce, { offert: true }));
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, raison: "erreur_serveur" });
  }
};
