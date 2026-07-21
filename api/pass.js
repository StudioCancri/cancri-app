/* ============================================================
   API CANCRI — /api/pass?jeton=XXX
   Génère et renvoie le vrai pass Apple Wallet (.pkpass) d'une
   carte, avec ses tampons réels et la grille dessinée.

   Le bouton "Ajouter à Apple Wallet" de carte.html pointe ici.

   Variables Vercel nécessaires :
   SUPABASE_URL, SUPABASE_SECRET
   PASS_WWDR, PASS_CERT, PASS_KEY  (base64 des .pem)
   PASS_KEY_PASSPHRASE  (optionnel)
   PASS_TYPE_ID, PASS_TEAM_ID, PASS_ORG, APP_URL
   ============================================================ */

const path = require("path");
const fs = require("fs");
const { PKPass } = require("passkit-generator");
let sharp;
try { sharp = require("sharp"); } catch (e) { sharp = null; }

/* ---------- Supabase (lecture seule ici) ---------- */
function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

async function sb(chemin) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    headers: { apikey: SECRET, Authorization: "Bearer " + SECRET },
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ---------- décodage des certificats depuis les variables ---------- */
function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) throw new Error("Variable manquante : " + nom);
  return Buffer.from(b64, "base64");
}

/* ---------- couleurs → rgb array pour le dessin ---------- */
function rgbArray(rgbStr, fallback) {
  const m = (rgbStr || "").match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return fallback;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

/* ---------- SVG de la grille de tampons ---------- */
function svgStrip(tampons, objectif, fondRgb, labelRgb) {
  const W = 1125, H = 432;
  const fond = "rgb(" + fondRgb.join(",") + ")";
  const label = "rgb(" + labelRgb.join(",") + ")";
  const rows = objectif <= 6 ? 1 : 2;
  const cols = Math.ceil(objectif / rows);
  const cellW = W / cols, cellH = H / rows;
  const D = Math.min(cellW, cellH) * 0.62, R = D / 2;
  let els = '<rect width="' + W + '" height="' + H + '" fill="' + fond + '"/>';
  for (let i = 0; i < objectif; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const cx = col * cellW + cellW / 2, cy = row * cellH + cellH / 2;
    if (i < tampons) {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + label + '"/>';
      const p1x = cx - R * 0.38, p1y = cy + R * 0.02;
      const p2x = cx - R * 0.08, p2y = cy + R * 0.34;
      const p3x = cx + R * 0.42, p3y = cy - R * 0.3;
      els += '<path d="M ' + p1x + ' ' + p1y + ' L ' + p2x + ' ' + p2y + ' L ' + p3x + ' ' + p3y +
             '" fill="none" stroke="' + fond + '" stroke-width="' + D * 0.13 +
             '" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + label +
             '" stroke-opacity="0.5" stroke-width="7" stroke-dasharray="16 13"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
         '" viewBox="0 0 ' + W + ' ' + H + '">' + els + '</svg>';
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    const jeton = (req.query && req.query.jeton) || "";
    if (!jeton) return res.status(400).send("jeton manquant");

    /* carte + commerce */
    const cartes = await sb("cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*");
    if (!cartes || !cartes[0]) return res.status(404).send("carte inconnue");
    const carte = cartes[0];
    const commerces = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
    const commerce = commerces[0];

    const fondRgb = rgbArray(commerce.couleur_fond, [42, 29, 20]);
    const labelRgb = rgbArray(commerce.couleur_label, [240, 223, 198]);
    const fgRgb = rgbArray(commerce.couleur_texte, [251, 249, 244]);

    /* dossier d'images du modèle */
    const modelDir = path.join(process.cwd(), "pass-assets");

    /* on rassemble tous les buffers d'images */
    const buffers = {};
    const imgs = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png"];
    for (const f of imgs) {
      const ip = path.join(modelDir, f);
      if (fs.existsSync(ip)) buffers[f] = fs.readFileSync(ip);
    }

    /* strip = grille dessinée à la volée */
    if (sharp) {
      const svg = Buffer.from(svgStrip(carte.tampons, commerce.objectif, fondRgb, labelRgb));
      buffers["strip.png"] = await sharp(svg).resize(375, 144).png().toBuffer();
      buffers["strip@2x.png"] = await sharp(svg).resize(750, 288).png().toBuffer();
      buffers["strip@3x.png"] = await sharp(svg).resize(1125, 432).png().toBuffer();
    }

    /* pass.json (le modèle) sous forme de buffer */
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
      locations: (commerce.latitude && commerce.longitude) ? [{
        latitude: commerce.latitude,
        longitude: commerce.longitude,
        relevantText: commerce.texte_geoloc || "Vous êtes tout près !"
      }] : undefined,
    }));

    /* construction du pass à partir des buffers */
    const pass = new PKPass(buffers, {
      wwdr: certDepuisEnv("PASS_WWDR"),
      signerCert: certDepuisEnv("PASS_CERT"),
      signerKey: certDepuisEnv("PASS_KEY"),
      signerKeyPassphrase: process.env.PASS_KEY_PASSPHRASE || undefined,
    });

    /* champs */
    pass.headerFields.push({ key: "solde", label: commerce.unite, value: carte.tampons + "/" + commerce.objectif });
    pass.secondaryFields.push(
      { key: "membre", label: "MEMBRE", value: carte.prenom || "Client" },
      { key: "reward", label: "RÉCOMPENSE", value: commerce.recompense }
    );
    if (carte.message_relance && carte.message_relance.trim()) {
      pass.backFields.push({ key: "relance", label: "Un petit rappel", value: carte.message_relance, changeMessage: "%@" });
    }
    if (commerce.message_actuel && commerce.message_actuel.trim()) {
      pass.backFields.push({ key: "actu", label: "À ne pas manquer", value: commerce.message_actuel, changeMessage: "%@" });
    }
    pass.backFields.push(
      { key: "regle", label: "Comment ça marche", value: "Posez votre téléphone sur la pastille au comptoir : +1 tampon. À " + commerce.objectif + ", votre récompense vous attend." },
      { key: "studio", label: "Propulsé par", value: "Studio Cancri" }
    );

    /* mise à jour automatique (Phase C) : on branche déjà la webServiceURL */
    if (process.env.APP_URL) {
      pass.setBarcodes({ message: carte.jeton, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
    }

    const buffer = pass.getAsBuffer();
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", 'attachment; filename="carte.pkpass"');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Erreur génération pass : " + (e.message || e));
  }
};
