/* ============================================================
   API CANCRI — /api/carte  (Vercel serverless)
   Une seule porte d'entrée, 5 actions :
   - creer     : nouvelle carte (tampon de bienvenue = 1)
                 si l'email a déjà une carte ici → code envoyé par mail
   - recuperer : le client retrouve sa carte avec le code reçu
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
const { capacites } = require("./plans");

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
/* récupération de carte par code email */
const CODE_DUREE_MS = 10 * 60 * 1000;
const CODE_ESSAIS_MAX = 5;
const COOKIE_DUREE_S = 400 * 24 * 3600;

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
  return { ok: true, appareil_id: puce.appareil_id || null };
}

/* ---------- mémoire du téléphone : cookie posé par le serveur ----------
   Safari efface la mémoire des pages (localStorage) au bout de 7 jours sans
   interaction. Un cookie HttpOnly posé par le serveur résiste beaucoup mieux :
   c'est notre filet de sécurité pour reconnaître le client au tap. */
function lireCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(function (morceau) {
    const i = morceau.indexOf("=");
    if (i > 0) {
      try { out[morceau.slice(0, i).trim()] = decodeURIComponent(morceau.slice(i + 1).trim()); } catch (e) {}
    }
  });
  return out;
}
function nomCookie(slug) {
  return "lunat_j_" + String(slug || "").replace(/[^a-zA-Z0-9-]/g, "");
}
function poserCookie(res, slug, jeton) {
  if (!slug || !jeton) return;
  res.setHeader("Set-Cookie",
    nomCookie(slug) + "=" + encodeURIComponent(jeton) +
    "; Path=/; Max-Age=" + COOKIE_DUREE_S + "; Secure; HttpOnly; SameSite=Lax");
}

/* ---------- email ---------- */
function normaliserEmail(v) {
  const e = (v || "").toString().trim().toLowerCase().slice(0, 80);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}
function masquerEmail(e) {
  const i = e.indexOf("@");
  if (i < 1) return e;
  return e.charAt(0) + "***" + e.slice(i);
}
/* carte existante pour cet email chez ce commerce (la plus récente) */
async function carteParEmail(commerceId, email) {
  const motif = email.replace(/[\\%_]/g, "\\$&");
  const rows = await sb(
    "cartes?commerce_id=eq." + commerceId +
    "&email=ilike." + encodeURIComponent(motif) +
    "&select=*&order=cree_le.desc&limit=1"
  );
  return rows && rows[0] ? rows[0] : null;
}

/* ---------- code de récupération ---------- */
function hacherCode(code, carteId) {
  return crypto.createHash("sha256").update(String(code) + ":" + carteId).digest("hex");
}
async function envoyerMailCode(email, code, commerce) {
  const cle = (process.env.RESEND_API_KEY || "").trim();
  if (!cle) throw new Error("RESEND_API_KEY absente");
  const de = (process.env.MAIL_EXPEDITEUR || "Lunat <bonjour@lunat.fr>").trim();
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1B2027">' +
    '<p style="font-size:15px;margin:0 0 12px">Bonjour,</p>' +
    '<p style="font-size:15px;margin:0 0 18px">Voici ton code pour retrouver ta carte de fidélité <b>' + commerce.nom + '</b> :</p>' +
    '<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:0 0 18px">' + code + '</p>' +
    '<p style="font-size:13px;color:#666;margin:0">Il est valable 10 minutes. Si tu n\'as rien demandé, ignore ce message.</p>' +
    '<p style="font-size:12px;color:#999;margin:24px 0 0">Lunat · propulsé par Studio Cancri</p></div>';
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + cle, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: de,
      to: [email],
      reply_to: "contact@lunat.fr",
      subject: code + " : ton code pour retrouver ta carte " + commerce.nom,
      html: html,
      text: "Ton code pour retrouver ta carte " + commerce.nom + " : " + code + " (valable 10 minutes).",
    }),
  });
  if (!r.ok) throw new Error("Resend " + r.status + " : " + (await r.text()));
}
/* génère et envoie un code (pas plus d'un envoi par minute) */
async function envoyerCodeRecup(carte, commerce, email) {
  const maintenant = Date.now();
  if (carte.recup_expire) {
    const envoyeLe = new Date(carte.recup_expire).getTime() - CODE_DUREE_MS;
    if (maintenant - envoyeLe < 60 * 1000) return { ok: true, deja: true };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await sb("cartes?id=eq." + carte.id, {
    method: "PATCH",
    body: {
      recup_code: hacherCode(code, carte.id),
      recup_expire: new Date(maintenant + CODE_DUREE_MS).toISOString(),
      recup_essais: 0,
    },
  });
  try {
    await envoyerMailCode(email, code, commerce);
    return { ok: true };
  } catch (e) {
    console.error("mail code:", e.message);
    return { ok: false };
  }
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
    jeton: carte.jeton,
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
    mode: modeEffectif(commerce),
    points: carte.points || 0,
    recompenses_dispo: carte.recompenses_dispo || 0,
    recompenses_points: modeEffectif(commerce) === "points" ? listeRecompenses(commerce) : [],
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
  if (!jeton) return null;
  const rows = await sb(
    "cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*"
  );
  return rows && rows[0] ? rows[0] : null;
}

/* ============================================================
   CAISSE : ce que l'employé a saisi, consommé au tap du client
   ============================================================ */
function listeRecompenses(commerce) {
  let r = commerce.recompenses_points;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (e) { r = []; } }
  return Array.isArray(r) ? r : [];
}
function modeEffectif(commerce) {
  return commerce.mode === "points" && capacites(commerce).points ? "points" : "tampons";
}

/* la saisie en attente : celle de la caisse liée à la puce, sinon la plus récente du commerce */
async function attenteDuCommerce(commerce, appareilId) {
  let q = "caisse_attente?commerce_id=eq." + commerce.id +
    "&statut=eq.en_attente&expire_le=gt." + encodeURIComponent(new Date().toISOString());
  if (appareilId) q += "&appareil_id=eq." + appareilId;
  const rows = await sb(q + "&select=*&order=cree_le.desc&limit=1");
  return rows && rows[0] ? rows[0] : null;
}

/* applique la saisie à la carte du client → { carte, resultat } (null si déjà prise) */
async function appliquerAttente(a, carte, commerce) {
  /* on la réserve d'abord : si deux téléphones tapent en même temps, un seul gagne */
  const pris = await sb("caisse_attente?id=eq." + a.id + "&statut=eq.en_attente", {
    method: "PATCH",
    body: { statut: "consomme", carte_id: String(carte.id) },
  });
  if (!pris || !pris.length) return null;

  const mode = modeEffectif(commerce);
  const obj = commerce.objectif;
  const maintenant = new Date().toISOString();
  const base = {
    dernier_tap: maintenant,
    taps_aujourdhui: tapsDuJour(carte) + 1,
    jour_reference: aujourdhui(),
  };
  let patch = null, tap = null, resultat = null;

  if (a.type === "tampons") {
    const n = a.valeur || 1;
    let t = (carte.tampons || 0) + n;
    let dispo = carte.recompenses_dispo || 0;
    let debloquees = 0;
    while (t >= obj) { t -= obj; dispo++; debloquees++; }
    patch = Object.assign({ tampons: t, recompenses_dispo: dispo }, base);
    tap = { carte_id: carte.id, valeur: n, type: "tampon" };
    resultat = { ok: true, type: "tampons", gagne: n, tampons: t, objectif: obj, recompenses_dispo: dispo, debloquees: debloquees };

  } else if (a.type === "points") {
    const gagne = Math.floor((a.valeur / 100) * (Number(commerce.points_par_euro) || 1));
    const total = (carte.points || 0) + gagne;
    patch = Object.assign({ points: total }, base);
    tap = { carte_id: carte.id, valeur: 1, type: "points", points: gagne, montant_cents: a.valeur };
    resultat = { ok: true, type: "points", gagne: gagne, points: total, montant_cents: a.valeur };

  } else if (a.type === "recompense") {
    if (mode === "points") {
      const rec = listeRecompenses(commerce).find(function (x) { return x.id === a.recompense_id; });
      const solde = carte.points || 0;
      if (!rec || solde < rec.cout) {
        resultat = { ok: false, raison: "points_insuffisants", points: solde, cout: rec ? rec.cout : a.valeur, recompense: rec ? rec.nom : "" };
      } else {
        patch = { points: solde - rec.cout, dernier_tap: maintenant };
        tap = { carte_id: carte.id, valeur: 0, type: "recompense", points: -rec.cout };
        resultat = { ok: true, type: "recompense", recompense: rec.nom, points: solde - rec.cout };
      }
    } else {
      const dispo = carte.recompenses_dispo || 0;
      if (dispo > 0) {
        patch = { recompenses_dispo: dispo - 1, dernier_tap: maintenant };
      } else if ((carte.tampons || 0) >= obj) {
        patch = { tampons: 0, dernier_tap: maintenant }; // ancienne carte pleine
      }
      if (patch) {
        tap = { carte_id: carte.id, valeur: 0, type: "recompense" };
        resultat = { ok: true, type: "recompense", recompense: commerce.recompense, recompenses_dispo: patch.recompenses_dispo !== undefined ? patch.recompenses_dispo : dispo };
      } else {
        resultat = { ok: false, raison: "aucune_recompense", tampons: carte.tampons || 0, objectif: obj };
      }
    }
  }

  let carteMaj = carte;
  if (patch) {
    const maj = await sb("cartes?id=eq." + carte.id, { method: "PATCH", body: patch });
    carteMaj = maj[0];
    await sb("taps", { method: "POST", body: tap });
    try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); }
  }
  resultat = resultat || { ok: false, raison: "type_inconnu" };
  resultat.prenom = carte.prenom || null;
  await sb("caisse_attente?id=eq." + a.id, { method: "PATCH", body: { resultat: resultat } });
  return { carte: carteMaj, resultat: resultat };
}

/* +1 tampon avec les garde-fous (pleine, cooldown, limite) → réponse à renvoyer */
async function appliquerTap(carte, commerce) {
  if (carte.tampons >= commerce.objectif) {
    return etat(carte, commerce, { ok: false, raison: "pleine" });
  }
  const dernier = carte.dernier_tap ? new Date(carte.dernier_tap).getTime() : 0;
  const ecart = Math.floor((Date.now() - dernier) / 1000);
  if (dernier && ecart < COOLDOWN_S) {
    return etat(carte, commerce, { ok: false, raison: "cooldown", secondes: COOLDOWN_S - ecart });
  }
  if (tapsDuJour(carte) >= TAPS_MAX_JOUR) {
    return etat(carte, commerce, { ok: false, raison: "limite" });
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
  await sb("taps", { method: "POST", body: { carte_id: carte.id, valeur: 1, type: "tampon" } });
  /* mise à jour du pass Wallet */
  try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); }
  return etat(maj[0], commerce, { gagne: 1 });
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

      /* email obligatoire, et s'il a déjà une carte ici : pas de doublon,
         on envoie un code pour qu'il la récupère (la preuve NFC n'est pas consommée) */
      const emailNet = normaliserEmail(body.email);
      if (!emailNet) return res.status(200).json({ ok: false, raison: "email_requis" });
      const existante = await carteParEmail(commerce.id, emailNet);
      if (existante) {
        const envoi = await envoyerCodeRecup(existante, commerce, emailNet);
        return res.status(200).json({
          ok: false,
          raison: "email_existant",
          envoye: envoi.ok,
          email_masque: masquerEmail(emailNet),
          commerce: commerce.nom,
        });
      }

      /* si le commerce est passé en NFC obligatoire, la création aussi doit être prouvée */
      let appareilPuce = null;
      if (commerce.nfc_requis === true) {
        const v = verifierSdm(body.p, body.m);
        if (!v.ok) return res.status(200).json({ ok: false, raison: v.raison });
        const c = await consommerTapNfc(v.uid, v.compteur, commerce);
        if (!c.ok) return res.status(200).json({ ok: false, raison: c.raison });
        appareilPuce = c.appareil_id;
      }

      const prenom = (body.prenom || "").toString().trim().slice(0, 20) || null;
      const nom = (body.nom || "").toString().trim().slice(0, 30) || null;
      const email = emailNet;
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
        body: { carte_id: carte.id, valeur: TAMPON_DEPART, type: "tampon" },
      });
      poserCookie(res, commerce.slug, jeton);
      /* un nouveau client à la caisse : l'employé a peut-être déjà saisi son achat */
      const attenteC = await attenteDuCommerce(commerce, appareilPuce);
      if (attenteC) {
        const out = await appliquerAttente(attenteC, carte, commerce);
        if (out) {
          return res.status(200).json(etat(out.carte, commerce, { jeton: jeton, bienvenue: true, caisse: true, resultat: out.resultat }));
        }
      }
      return res
        .status(200)
        .json(etat(carte, commerce, { jeton: jeton, bienvenue: true }));
    }

    /* ----- ENVOYER_CODE : renvoyer un code de récupération ----- */
    if (action === "envoyer_code") {
      const commerce = await commerceParSlug(body.commerce || "");
      if (!commerce) return res.status(200).json({ ok: false, raison: "commerce_inconnu" });
      const email = normaliserEmail(body.email);
      if (!email) return res.status(200).json({ ok: false, raison: "email_requis" });
      const c = await carteParEmail(commerce.id, email);
      if (!c) return res.status(200).json({ ok: false, raison: "recup_introuvable" });
      const envoi = await envoyerCodeRecup(c, commerce, email);
      return res.status(200).json({ ok: envoi.ok, raison: envoi.ok ? undefined : "envoi_impossible", email_masque: masquerEmail(email) });
    }

    /* ----- RECUPERER : le client retrouve sa carte avec le code reçu ----- */
    if (action === "recuperer") {
      const commerce = await commerceParSlug(body.commerce || "");
      if (!commerce) return res.status(200).json({ ok: false, raison: "commerce_inconnu" });
      const email = normaliserEmail(body.email);
      if (!email) return res.status(200).json({ ok: false, raison: "email_requis" });
      const c = await carteParEmail(commerce.id, email);
      if (!c || !c.recup_code) return res.status(200).json({ ok: false, raison: "recup_introuvable" });
      if ((c.recup_essais || 0) >= CODE_ESSAIS_MAX) return res.status(200).json({ ok: false, raison: "recup_bloque" });
      if (!c.recup_expire || new Date(c.recup_expire).getTime() < Date.now()) {
        return res.status(200).json({ ok: false, raison: "recup_expire" });
      }
      const code = (body.code || "").toString().replace(/\D/g, "");
      if (hacherCode(code, c.id) !== c.recup_code) {
        await sb("cartes?id=eq." + c.id, { method: "PATCH", body: { recup_essais: (c.recup_essais || 0) + 1 } });
        return res.status(200).json({ ok: false, raison: "recup_code" });
      }
      await sb("cartes?id=eq." + c.id, {
        method: "PATCH",
        body: { recup_code: null, recup_expire: null, recup_essais: 0 },
      });
      poserCookie(res, commerce.slug, c.jeton);

      /* le tampon de cette visite, si le client vient de taper la puce */
      let visiteProuvee = false;
      let appareilPuce = null;
      if (body.p && body.m) {
        const v = verifierSdm(body.p, body.m);
        if (v.ok) {
          const k = await consommerTapNfc(v.uid, v.compteur, commerce);
          visiteProuvee = k.ok;
          appareilPuce = k.appareil_id || null;
        }
      } else if (commerce.nfc_requis !== true && body.tap === true) {
        visiteProuvee = true;
      }
      if (visiteProuvee) {
        const attenteR = await attenteDuCommerce(commerce, appareilPuce);
        if (attenteR) {
          const out = await appliquerAttente(attenteR, c, commerce);
          if (out) return res.status(200).json(etat(out.carte, commerce, { recupere: true, caisse: true, resultat: out.resultat }));
        }
      }
      if (visiteProuvee && modeEffectif(commerce) === "tampons" && commerce.tap_auto !== false) {
        const r = await appliquerTap(c, commerce);
        if (r.ok === false) return res.status(200).json(etat(c, commerce, { recupere: true, tap_raison: r.raison }));
        r.recupere = true;
        return res.status(200).json(r);
      }
      return res.status(200).json(etat(c, commerce, { recupere: true }));
    }

    /* ----- toutes les autres actions : on retrouve la carte
       par le jeton du téléphone, sinon par le cookie du commerce ----- */
    let carte = await carteParJeton(body.jeton || "");
    if (!carte && body.commerce) {
      const cookies = lireCookies(req);
      carte = await carteParJeton(cookies[nomCookie(body.commerce)] || "");
    }
    if (!carte) {
      return res.status(200).json({ ok: false, raison: "carte_inconnue" });
    }
    const rows = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
    const commerce = rows[0];
    poserCookie(res, commerce.slug, carte.jeton);

    /* ----- ETAT ----- */
    if (action === "etat") {
      return res.status(200).json(etat(carte, commerce));
    }

    /* ----- TAP : +1 tampon ----- */
    if (action === "tap") {
      /* --- porte d'entrée anti-triche : une vraie puce, un tap jamais rejoué --- */
      let appareilPuce = null;
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
        appareilPuce = c.appareil_id;
      }

      /* 1. l'employé a saisi quelque chose à la caisse → on l'applique */
      const attente = await attenteDuCommerce(commerce, appareilPuce);
      if (attente) {
        const out = await appliquerAttente(attente, carte, commerce);
        if (out) return res.status(200).json(etat(out.carte, commerce, { caisse: true, resultat: out.resultat }));
      }
      /* 2. rien en attente : en points (ou si la caisse est obligatoire), on montre juste le solde */
      if (modeEffectif(commerce) === "points" || commerce.tap_auto === false) {
        return res.status(200).json(etat(carte, commerce, { solde: true }));
      }
      /* 3. ancien fonctionnement : +1 automatique */
      return res.status(200).json(await appliquerTap(carte, commerce));
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
