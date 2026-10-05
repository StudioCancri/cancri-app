/* ============================================================
   API CANCRI — /api/wallet
   Gère TOUT le protocole de mise à jour Apple Wallet :
   - enregistrement / désenregistrement d'un appareil
   - liste des cartes modifiées
   - téléchargement du pass à jour
   - log Apple

   Les vraies URL Apple (/v1/devices/... ) sont redirigées ici
   par vercel.json.
   ============================================================ */

const path = require("path");
const fs = require("fs");
const { PKPass } = require("passkit-generator");
const { capacites } = require("./plans");
const http2 = require("http2");
let sharp;
try { sharp = require("sharp"); } catch (e) { sharp = null; }

/* ---------- Supabase ---------- */
function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

async function sb(chemin, options) {
  options = options || {};
  const headers = { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" };
  if (options.method === "POST" || options.method === "PATCH" || options.method === "DELETE") {
    headers["Prefer"] = "return=representation";
  }
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) throw new Error("Variable manquante : " + nom);
  return Buffer.from(b64, "base64");
}

/* ============================================================
   ENVOI DE LA NOTIFICATION PUSH (méthode certificat)
   Appelée depuis api/carte.js après chaque tap.
   ============================================================ */
async function envoyerPush(jeton) {
  const appareils = await sb("appareils?jeton=eq." + encodeURIComponent(jeton) + "&select=push_token");
  if (!appareils || !appareils.length) {
    console.log("push: aucun appareil enregistré pour ce jeton");
    return;
  }

  const cert = certDepuisEnv("PASS_CERT");
  const key = certDepuisEnv("PASS_KEY");
  const passphrase = process.env.PASS_KEY_PASSPHRASE || undefined;

  for (const a of appareils) {
    if (!a.push_token) continue;
    await new Promise((resolve) => {
      let fini = false;
      const done = (msg) => {
        if (fini) return;
        fini = true;
        if (msg) console.log("push:", msg);
        try { client.close(); } catch (e) {}
        resolve();
      };

      const client = http2.connect("https://api.push.apple.com:443", {
        cert: cert,
        key: key,
        passphrase: passphrase,
      });

      // filet de sécurité : on ne bloque jamais plus de 8 s
      const minuteur = setTimeout(() => done("timeout APNs (8s)"), 8000);

      client.on("error", (e) => { clearTimeout(minuteur); done("connexion APNs échouée : " + (e.message || e)); });

      const body = JSON.stringify({});
      const req = client.request({
        ":method": "POST",
        ":path": "/3/device/" + a.push_token,
        "apns-topic": process.env.PASS_TYPE_ID,
        "apns-push-type": "background",
        "apns-priority": "5",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });

      let statut = 0;
      let reponse = "";
      req.on("response", (h) => { statut = h[":status"]; });
      req.on("data", (c) => { reponse += c; });
      req.on("end", () => {
        clearTimeout(minuteur);
        done("APNs statut " + statut + (statut === 200 ? " ✅ envoyé" : " ⚠️ " + reponse));
      });
      req.on("error", (e) => { clearTimeout(minuteur); done("requête APNs échouée : " + (e.message || e)); });

      req.write(body);
      req.end();
    });
  }
}
module.exports.envoyerPush = envoyerPush;

/* ---------- (ré)génère le .pkpass d'une carte ---------- */
async function construirePass(jeton) {
  const cartes = await sb("cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*");
  if (!cartes || !cartes[0]) return null;
  const carte = cartes[0];
  const commerces = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
  const commerce = commerces[0];

  const rgb = (s, f) => { const m = (s || "").match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); return m ? [+m[1], +m[2], +m[3]] : f; };
  const fondRgb = rgb(commerce.couleur_fond, [42, 29, 20]);
  const labelRgb = rgb(commerce.couleur_label, [240, 223, 198]);
  const fgRgb = rgb(commerce.couleur_texte, [251, 249, 244]);

  const dossierCommerce = path.join(process.cwd(), "pass-assets", commerce.slug || "");
  const dossierDefaut = path.join(process.cwd(), "pass-assets");
  const buffers = {};
  for (const f of ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png"]) {
    const propre = path.join(dossierCommerce, f);
    const defaut = path.join(dossierDefaut, f);
    if (fs.existsSync(propre)) buffers[f] = fs.readFileSync(propre);
    else if (fs.existsSync(defaut)) buffers[f] = fs.readFileSync(defaut);
  }
  if (sharp) {
    const svg = Buffer.from(estModePoints(commerce)
      ? svgPoints(carte.points || 0, listeRecompensesPass(commerce), fondRgb, labelRgb)
      : svgStrip(carte.tampons, commerce.objectif, fondRgb, labelRgb));
    buffers["strip.png"] = await sharp(svg).resize(375, 144).png().toBuffer();
    buffers["strip@2x.png"] = await sharp(svg).resize(750, 288).png().toBuffer();
    buffers["strip@3x.png"] = await sharp(svg).resize(1125, 432).png().toBuffer();
  }
  buffers["pass.json"] = Buffer.from(JSON.stringify({
    formatVersion: 1,
    passTypeIdentifier: process.env.PASS_TYPE_ID,
    teamIdentifier: process.env.PASS_TEAM_ID,
    organizationName: commerce.nom,
    description: "Carte de fidélité — " + commerce.nom,
    serialNumber: carte.jeton,
    logoText: commerce.nom,
    backgroundColor: "rgb(" + fondRgb.join(", ") + ")",
    foregroundColor: "rgb(" + fgRgb.join(", ") + ")",
    labelColor: "rgb(" + labelRgb.join(", ") + ")",
    webServiceURL: (process.env.APP_URL || ""),
    authenticationToken: carte.jeton,
    storeCard: {},
  }));

  const pass = new PKPass(buffers, {
    wwdr: certDepuisEnv("PASS_WWDR"),
    signerCert: certDepuisEnv("PASS_CERT"),
    signerKey: certDepuisEnv("PASS_KEY"),
    signerKeyPassphrase: process.env.PASS_KEY_PASSPHRASE || undefined,
  });
  champsRecto(pass, carte, commerce);

  /* message affiché au dos : celui de la carte prime, sinon celui du commerce */
  const messageCarte = (carte.message_perso && carte.message_perso.trim())
    ? carte.message_perso.trim()
    : ((commerce.message_actuel && commerce.message_actuel.trim()) ? commerce.message_actuel.trim() : "");
  if (messageCarte) {
    pass.backFields.push({ key: "actu", label: "À ne pas manquer", value: messageCarte, changeMessage: "%@" });
  }
  /* lien de secours : reconnecte ce téléphone à sa carte (Safari peut oublier) */
  const lienRetrouver = "https://lunat.fr" +
    "/carte.html?c=" + encodeURIComponent(commerce.slug) + "&j=" + encodeURIComponent(carte.jeton);
  pass.backFields.push(
    { key: "regle", label: "Comment ça marche", value: texteRegle(commerce) },
    { key: "retrouver", label: "Votre carte sur ce téléphone",
      value: "Si on vous redemande de vous inscrire, touchez ce lien : " + lienRetrouver,
      attributedValue: 'Si on vous redemande de vous inscrire : <a href="' + lienRetrouver + '">Retrouver ma carte</a>' },
    { key: "studio", label: "Propulsé par", value: "Studio Cancri" }
  );
  pass.setBarcodes({ message: carte.jeton, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
  return { pass, carte };
}

/* ============================================================
   MODE POINTS : ce que la carte Wallet affiche à la place des tampons
   ============================================================ */
function listeRecompensesPass(commerce) {
  let r = commerce.recompenses_points;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (e) { r = []; } }
  return (Array.isArray(r) ? r : []).filter(function (x) { return x && x.cout > 0; })
    .sort(function (a, b) { return a.cout - b.cout; });
}
function estModePoints(commerce) {
  return commerce.mode === "points" && capacites(commerce).points;
}
/* barre de progression vers les récompenses (aucun texte : rendu fiable partout) */
function svgPoints(points, recs, fondRgb, labelRgb) {
  const W = 1125, H = 432;
  const fond = "rgb(" + fondRgb.join(",") + ")", label = "rgb(" + labelRgb.join(",") + ")";
  const max = recs.length ? recs[recs.length - 1].cout : 100;
  const x0 = 120, x1 = W - 120, y = H / 2, ep = 30, R = 44;
  const ratio = Math.max(0, Math.min(1, points / max));
  let els = '<rect width="' + W + '" height="' + H + '" fill="' + fond + '"/>';
  els += '<rect x="' + x0 + '" y="' + (y - ep / 2) + '" width="' + (x1 - x0) + '" height="' + ep + '" rx="' + ep / 2 + '" fill="' + label + '" fill-opacity="0.25"/>';
  if (ratio > 0) {
    els += '<rect x="' + x0 + '" y="' + (y - ep / 2) + '" width="' + Math.max(ep, (x1 - x0) * ratio) + '" height="' + ep + '" rx="' + ep / 2 + '" fill="' + label + '"/>';
  }
  for (const r of recs) {
    const cx = x0 + (x1 - x0) * (r.cout / max);
    const atteint = points >= r.cout;
    els += '<circle cx="' + cx + '" cy="' + y + '" r="' + R + '" fill="' + (atteint ? label : fond) + '" stroke="' + label + '" stroke-width="8"/>';
    if (atteint) {
      els += '<path d="M ' + (cx - R * 0.38) + ' ' + (y + R * 0.02) + ' L ' + (cx - R * 0.08) + ' ' + (y + R * 0.34) + ' L ' + (cx + R * 0.42) + ' ' + (y - R * 0.3) +
        '" fill="none" stroke="' + fond + '" stroke-width="' + R * 0.26 + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + els + '</svg>';
}
/* les champs du recto, selon le mode */
function champsRecto(pass, carte, commerce) {
  const dispo = carte.recompenses_dispo || 0;
  if (estModePoints(commerce)) {
    const recs = listeRecompensesPass(commerce);
    const pts = carte.points || 0;
    const utilisables = recs.filter(function (x) { return x.cout <= pts; });
    const prochaine = recs.find(function (x) { return x.cout > pts; });
    pass.headerFields.push({ key: "solde", label: "POINTS", value: pts, changeMessage: "Tu as maintenant %@ points" });
    pass.secondaryFields.push({ key: "membre", label: "MEMBRE", value: carte.prenom || "Client" });
    if (utilisables.length) {
      pass.secondaryFields.push({ key: "reward", label: "À UTILISER", value: utilisables[utilisables.length - 1].nom, changeMessage: "Récompense disponible : %@" });
    } else if (prochaine) {
      pass.secondaryFields.push({ key: "reward", label: "PROCHAINE RÉCOMPENSE", value: prochaine.nom + " à " + prochaine.cout + " pts" });
    }
    return;
  }
  pass.headerFields.push({ key: "solde", label: commerce.unite, value: carte.tampons + "/" + commerce.objectif });
  pass.secondaryFields.push(
    { key: "membre", label: "MEMBRE", value: carte.prenom || "Client" },
    { key: "reward", label: "RÉCOMPENSE", value: commerce.recompense }
  );
  if (dispo > 0) {
    pass.auxiliaryFields.push({ key: "reserve", label: "EN RÉSERVE", value: dispo + (dispo > 1 ? " récompenses" : " récompense"),
      changeMessage: "Récompense débloquée, tu en as %@" });
  }
}
function texteRegle(commerce) {
  if (estModePoints(commerce)) {
    return "Au comptoir, l'équipe saisit votre achat, puis vous posez votre téléphone sur la pastille : vous gagnez vos points. Utilisez-les quand vous voulez contre une récompense.";
  }
  return "Posez votre téléphone sur la pastille au comptoir pour gagner vos tampons. À " + commerce.objectif + ", votre récompense vous attend, et vous pouvez la garder pour plus tard.";
}

function svgStrip(tampons, objectif, fondRgb, labelRgb) {
  const W = 1125, H = 432;
  const fond = "rgb(" + fondRgb.join(",") + ")", label = "rgb(" + labelRgb.join(",") + ")";
  const rows = objectif <= 6 ? 1 : 2, cols = Math.ceil(objectif / rows);
  const cellW = W / cols, cellH = H / rows, D = Math.min(cellW, cellH) * 0.62, R = D / 2;
  let els = '<rect width="' + W + '" height="' + H + '" fill="' + fond + '"/>';
  for (let i = 0; i < objectif; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const cx = col * cellW + cellW / 2, cy = row * cellH + cellH / 2;
    if (i < tampons) {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + label + '"/>';
      els += '<path d="M ' + (cx - R * 0.38) + ' ' + (cy + R * 0.02) + ' L ' + (cx - R * 0.08) + ' ' + (cy + R * 0.34) + ' L ' + (cx + R * 0.42) + ' ' + (cy - R * 0.3) + '" fill="none" stroke="' + fond + '" stroke-width="' + D * 0.13 + '" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + label + '" stroke-opacity="0.5" stroke-width="7" stroke-dasharray="16 13"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + els + '</svg>';
}

/* ============================================================
   ROUTEUR — analyse l'URL Apple et agit en conséquence
   ============================================================ */
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    console.log("wallet:", req.method, url.pathname);
    const parts = url.pathname.split("/").filter(Boolean); // ex: v1, devices, xxx, registrations, yyy, zzz
    // on retire un éventuel préfixe "api"
    if (parts[0] === "api") parts.shift();
    // parts commence maintenant par "v1" ou "wallet"
    if (parts[0] === "wallet") parts.shift();

    const seg = parts; // [v1, ...]

    /* --- ENREGISTREMENT : PUSH/DELETE /v1/devices/{dev}/registrations/{ptid}/{serial} --- */
    if (seg[1] === "devices" && seg[3] === "registrations" && seg[5]) {
      const deviceId = seg[2];
      const serial = seg[5]; // = jeton de la carte

      if (req.method === "POST") {
        let pushToken = "";
        try {
          if (req.body !== undefined && req.body !== null) {
            const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
            pushToken = (b && b.pushToken) || "";
          } else {
            const raw = await new Promise((resolve) => {
              let data = "";
              const t = setTimeout(() => resolve(data), 1500);
              req.on("data", (c) => (data += c));
              req.on("end", () => { clearTimeout(t); resolve(data); });
              req.on("error", () => { clearTimeout(t); resolve(data); });
            });
            try { pushToken = JSON.parse(raw || "{}").pushToken || ""; } catch (e) {}
          }
        } catch (e) {}
        console.log("wallet: enregistrement appareil, token présent:", pushToken ? "oui" : "NON");
        // upsert appareil
        const existe = await sb("appareils?device_id=eq." + encodeURIComponent(deviceId) + "&jeton=eq." + encodeURIComponent(serial) + "&select=id");
        if (existe && existe.length) {
          await sb("appareils?id=eq." + existe[0].id, { method: "PATCH", body: { push_token: pushToken } });
          return res.status(200).end();
        }
        await sb("appareils", { method: "POST", body: { device_id: deviceId, push_token: pushToken, jeton: serial } });
        return res.status(201).end();
      }

      if (req.method === "DELETE") {
        await sb("appareils?device_id=eq." + encodeURIComponent(deviceId) + "&jeton=eq." + encodeURIComponent(serial), { method: "DELETE" });
        return res.status(200).end();
      }
    }

    /* --- LISTE DES CARTES MODIFIÉES : GET /v1/devices/{dev}/registrations/{ptid}?passesUpdatedSince=X --- */
    if (seg[1] === "devices" && seg[3] === "registrations" && !seg[5] && req.method === "GET") {
      const deviceId = seg[2];
      const rows = await sb("appareils?device_id=eq." + encodeURIComponent(deviceId) + "&select=jeton");
      if (!rows || !rows.length) return res.status(204).end();
      const jetons = rows.map((r) => r.jeton);
      console.log("[wallet] iPhone verifie ses cartes :", jetons.length, "serial(s) annonce(s)");
      return res.status(200).json({
        serialNumbers: jetons,
        lastUpdated: String(Math.floor(Date.now() / 1000)),
      });
    }

    /* --- TÉLÉCHARGEMENT DU PASS À JOUR : GET /v1/passes/{ptid}/{serial} --- */
    if (seg[1] === "passes" && seg[3] && req.method === "GET") {
      const serial = seg[3];
      console.log("[wallet] iPhone demande le pass", serial.slice(0, 8) + "…");
      const built = await construirePass(serial);
      if (!built) { console.log("[wallet] pass introuvable pour ce serial → 404"); return res.status(404).end(); }
      res.setHeader("Content-Type", "application/vnd.apple.pkpass");
      res.setHeader("Last-Modified", new Date().toUTCString());
      console.log("[wallet] pass renvoyé → la carte devrait se mettre à jour");
      return res.status(200).send(built.pass.getAsBuffer());
    }

    /* --- LOG APPLE : POST /v1/log — l'iPhone nous raconte ses erreurs --- */
    if (seg[1] === "log") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = { brut: req.body }; } }
      const messages = (b && b.logs) ? b.logs : [b];
      for (const m of messages) console.log("[wallet][iPhone dit] :", typeof m === "string" ? m : JSON.stringify(m));
      return res.status(200).end();
    }

    return res.status(200).json({ ok: true, info: "Cancri wallet service" });
  } catch (e) {
    console.error("wallet error:", e.message || e);
    return res.status(500).end();
  }
};
