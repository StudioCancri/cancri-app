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
  if (!appareils || !appareils.length) return;

  const cert = certDepuisEnv("PASS_CERT");
  const key = certDepuisEnv("PASS_KEY");
  const passphrase = process.env.PASS_KEY_PASSPHRASE || undefined;

  for (const a of appareils) {
    await new Promise((resolve) => {
      const client = http2.connect("https://api.push.apple.com:443", {
        cert: cert,
        key: key,
        passphrase: passphrase,
      });
      client.on("error", () => { try { client.close(); } catch (e) {} resolve(); });
      const req = client.request({
        ":method": "POST",
        ":path": "/3/device/" + a.push_token,
        "apns-topic": process.env.PASS_TYPE_ID,
        "apns-push-type": "background",
        "apns-priority": "5",
      });
      req.on("response", () => {});
      req.on("end", () => { try { client.close(); } catch (e) {} resolve(); });
      req.on("error", () => { try { client.close(); } catch (e) {} resolve(); });
      req.write(JSON.stringify({}));
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

  const modelDir = path.join(process.cwd(), "pass-assets");
  const buffers = {};
  for (const f of ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png"]) {
    const ip = path.join(modelDir, f);
    if (fs.existsSync(ip)) buffers[f] = fs.readFileSync(ip);
  }
  if (sharp) {
    const svg = Buffer.from(svgStrip(carte.tampons, commerce.objectif, fondRgb, labelRgb));
    buffers["strip.png"] = await sharp(svg).resize(375, 144).png().toBuffer();
    buffers["strip@2x.png"] = await sharp(svg).resize(750, 288).png().toBuffer();
    buffers["strip@3x.png"] = await sharp(svg).resize(1125, 432).png().toBuffer();
  }
  buffers["pass.json"] = Buffer.from(JSON.stringify({
    formatVersion: 1,
    passTypeIdentifier: process.env.PASS_TYPE_ID,
    teamIdentifier: process.env.PASS_TEAM_ID,
    organizationName: process.env.PASS_ORG || "Studio Cancri",
    description: "Carte de fidélité — " + commerce.nom,
    serialNumber: carte.jeton,
    logoText: commerce.nom,
    backgroundColor: "rgb(" + fondRgb.join(", ") + ")",
    foregroundColor: "rgb(" + fgRgb.join(", ") + ")",
    labelColor: "rgb(" + labelRgb.join(", ") + ")",
    webServiceURL: (process.env.APP_URL || "") + "/api/wallet",
    authenticationToken: carte.jeton,
    storeCard: {},
  }));

  const pass = new PKPass(buffers, {
    wwdr: certDepuisEnv("PASS_WWDR"),
    signerCert: certDepuisEnv("PASS_CERT"),
    signerKey: certDepuisEnv("PASS_KEY"),
    signerKeyPassphrase: process.env.PASS_KEY_PASSPHRASE || undefined,
  });
  pass.headerFields.push({ key: "solde", label: commerce.unite, value: carte.tampons + "/" + commerce.objectif });
  pass.secondaryFields.push(
    { key: "membre", label: "MEMBRE", value: carte.prenom || "Client" },
    { key: "reward", label: "RÉCOMPENSE", value: commerce.recompense }
  );
  pass.backFields.push(
    { key: "regle", label: "Comment ça marche", value: "Posez votre téléphone sur la pastille au comptoir : +1 tampon. À " + commerce.objectif + ", votre récompense vous attend." },
    { key: "studio", label: "Propulsé par", value: "Studio Cancri" }
  );
  pass.setBarcodes({ message: carte.jeton, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
  return { pass, carte };
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
        let body = "";
        await new Promise((r) => { req.on("data", (c) => body += c); req.on("end", r); });
        let pushToken = "";
        try { pushToken = JSON.parse(body || "{}").pushToken || ""; } catch (e) {}
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
      return res.status(200).json({
        serialNumbers: jetons,
        lastUpdated: String(Math.floor(Date.now() / 1000)),
      });
    }

    /* --- TÉLÉCHARGEMENT DU PASS À JOUR : GET /v1/passes/{ptid}/{serial} --- */
    if (seg[1] === "passes" && seg[3] && req.method === "GET") {
      const serial = seg[3];
      const built = await construirePass(serial);
      if (!built) return res.status(404).end();
      res.setHeader("Content-Type", "application/vnd.apple.pkpass");
      res.setHeader("Last-Modified", new Date().toUTCString());
      return res.status(200).send(built.pass.getAsBuffer());
    }

    /* --- LOG APPLE : POST /v1/log --- */
    if (seg[1] === "log") {
      return res.status(200).end();
    }

    return res.status(200).json({ ok: true, info: "Cancri wallet service" });
  } catch (e) {
    console.error("wallet error:", e.message || e);
    return res.status(500).end();
  }
};
